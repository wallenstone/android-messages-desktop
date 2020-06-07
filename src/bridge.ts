// This script is injected into the webview.

import domtoimg from "dom-to-image";
import { ipcRenderer, remote } from "electron";
import {
  attachSpellCheckProvider,
  SpellCheckerProvider,
} from "electron-hunspell";
import fs from "fs";
import {
  EVENT_BRIDGE_INIT,
  EVENT_NOTIFICATION_REFLECT_READY,
  EVENT_SPELLING_REFLECT_READY,
  EVENT_UPDATE_USER_SETTING,
  EVENT_WEBVIEW_NOTIFICATION,
} from "./helpers/constants";
import { Dictionary } from "./helpers/dictionaryManager";
import { handleEnterPrefToggle } from "./helpers/inputManager";
import { popupContextMenu } from "./menu/contextMenu";

// Electron (or the build of Chromium it uses?) does not seem to have any default right-click menu, this adds our own.
remote.getCurrentWebContents().addListener("context-menu", popupContextMenu);

window.addEventListener("load", () => {
  // Conditionally let the main process know the page is (essentially) done loading.
  // This should defer spellchecker downloading in a way that avoids blocking the page UI :D

  // Without observing the DOM, we don't have a reliable way to let the main process know once
  // (and only once) that the main part of the app (not the QR code screen) has loaded, which is
  // when we need to init the spellchecker
  const onMutation = (
    mutationsList: MutationRecord[],
    observer: MutationObserver
  ) => {
    if (document.querySelector("mw-main-nav")) {
      // we're definitely logged-in if this is in the DOM
      ipcRenderer.send(EVENT_BRIDGE_INIT);
      observer.disconnect();
    }
    //   // In the future we could detect the "you've been signed in elsewhere" modal and notify the user here
  };

  const observer = new MutationObserver(onMutation);
  // There is always a body so TS is being dumb
  observer.observe((document.querySelector("body") as unknown) as HTMLElement, {
    childList: true,
    attributes: true,
  });
});

interface EventSpellingReadyParams {
  locale: string;
  spellCheckFiles: Dictionary;
  customWords: Record<string, string[]>;
}

// The main process, once receiving EVENT_BRIDGE_INIT, determines whether the user's current language allows for spellchecking
// and if so, (down)loads the necessary files, then sends an event to which the following listener responds and
// loads the spellchecker, if needed.
ipcRenderer.once(
  EVENT_SPELLING_REFLECT_READY,
  async (
    _event,
    { locale, spellCheckFiles, customWords }: EventSpellingReadyParams
  ) => {
    const provider = new SpellCheckerProvider();
    window.spellCheckHandler = provider;
    await provider.initialize();

    await provider.loadDictionary(
      locale,
      fs.readFileSync(spellCheckFiles.dic),
      fs.readFileSync(spellCheckFiles.aff)
    );

    const attached = await attachSpellCheckProvider(provider);
    attached.switchLanguage(locale);

    if (locale in customWords) {
      for (const word of customWords[locale]) {
        window.spellCheckHandler.addWord(locale, word);
      }
    }
  }
);

ipcRenderer.on(EVENT_UPDATE_USER_SETTING, (event, settingsList) => {
  if ("useDarkMode" in settingsList && settingsList.useDarkMode !== null) {
    if (settingsList.useDarkMode) {
      // Props to Google for making the web app use dark mode entirely based on this class
      // and for making the class name semantic!
      document.body.classList.add("dark-mode");
    } else {
      document.body.classList.remove("dark-mode");
    }
  }
  if ("enterToSend" in settingsList) {
    handleEnterPrefToggle(settingsList.enterToSend);
  }
});

const imgCache: { [key: string]: string | (() => Promise<void>) } = {};

/**
 *
 * This function initializes the imgCache
 * It fills it with either the img data blob or a function to generate the blob
 * TODO: Add check for already in cache allowing us to call this more than once if there is ever a cache miss
 *
 */
function getAllProfileImgs(): void {
  const conversations = Array.from(
    document.querySelectorAll("mws-conversation-list-item")
  );
  conversations.forEach((conversation) => {
    const name = conversation.querySelector("h3.name")?.textContent;
    if (name != null) {
      const imgTag = conversation.querySelector("img");
      let imgData: string | (() => Promise<void>);
      if (imgTag != null) {
        imgData = imgTag.src;
      } else {
        const nonImgImg = conversation.querySelector("div.non-image-avatar");
        if (nonImgImg == null) {
          return;
        }
        imgData = async () => {
          delete imgCache[name];
          imgCache[name] = await domtoimg.toPng(nonImgImg);
        };
      }
      imgCache[name] = imgData;
    }
  });
}

/**
 *
 * Attempts to split the title of the notification in a way that yeilds a cache hit
 * The character it splits at is hard coded and relient on google not changing it
 * I do not know a way around this for now so it will stay
 *
 * @param {string} title notification title to convert to cache key
 * @returns {string} cache key for indexing
 */
function getCacheKey(title: string): string {
  if (title.includes(" •")) {
    return title.split(" •")[0];
  }
  return title;
}

const OriginalBrowserNotification = Notification;

/**
 * Override the webview's window's instance of the Notification class and forward their data to the
 * main process. This is Necessary to generate and send a custom notification via Electron instead
 * of just forwarding the webview (Google) ones.
 *
 * Derived from:
 * https://github.com/electron/electron/blob/master/docs/api/ipc-main.md#sending-messages
 * https://stackoverflow.com/questions/2891096/addeventlistener-using-apply
 * https://stackoverflow.com/questions/31231622/event-listener-for-web-notification
 * https://stackoverflow.com/questions/1421257/intercept-javascript-event
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
Notification = function (title: string, options?: NotificationOptions) {
  if (Object.keys(imgCache).length === 0) {
    getAllProfileImgs();
  }
  if (options) {
    const cached = imgCache[getCacheKey(title)];
    if (cached) {
      if (typeof cached === "string") {
        options.image = cached;
      } else {
        // Creating the image here reduces ui lag because we are not doing loads at once
        // It is not gaurenteed to be done before the next message but this does not cause
        // a bug because the first act of this function is to delete itself from the cache.
        cached();
      }
    }
  }
  const notificationToSend = new OriginalBrowserNotification(title, options); // Still send the webview notification event so the rest of this code runs (and the ipc event fires)

  /**
   * Google's own notifications have a click event listener which takes care of highlighting
   * the conversation a notification belongs to, but this click listener does not carry over
   * when we block Google's and create our own Electron notification.
   *
   * What I would like to do here is just pass the listener function over IPC and call it in
   * the main process.
   *
   * However, Electron does not support sending functions or otherwise non-JSON data across IPC.
   * To solve this and be able to have both our click event listener (so we can show the app
   * window) and Google's (so the converstaion gets selected/highlighted), when the main process
   yncronously receives the notification data, it asyncronously sends a message back at which
   * time we can reliably get a reference to the Electron notification and attach Google's click
   * event listener.
   */

  /**
   * I do not understand exactly what is going on here and will leave it for the time being
   * TODO: understand what is going on and make it better
   */

  type Type = "click" | "close" | "error" | "show";
  type Listener = (ev: NotificationEventMap[Type]) => unknown;
  type Options = undefined | boolean | AddEventListenerOptions;
  let originalClickListener: Listener | null = null;

  const originalAddEventListener = notificationToSend.addEventListener;
  // Seems silly to have these be correct as there is no way to mess it up
  notificationToSend.addEventListener = (
    type: Type,
    listener: Listener,
    options?: Options
  ) => {
    if (type === "click") {
      originalClickListener = listener;
    } else {
      // Let all other event listeners be called, though they shouldn't have any effect
      // because the original notification is blocked in the renderer process.
      originalAddEventListener.call(
        notificationToSend,
        type,
        listener,
        options
      );
    }
  };

  /**
   *
   * This is ugly and I am not positive it is necessary
   * In the future I aim to make it so we do not need to pass the notification around as a global variable
   * I have ideas to do so which include but are not limited to listening for an event dispatched from the main process
   * when the notification is clicked and calling the listener instead of adding it directly
   *
   */

  ipcRenderer.once(EVENT_NOTIFICATION_REFLECT_READY, () => {
    const theHookedUpNotification = remote.getGlobal("currentNotification");
    if (
      typeof theHookedUpNotification === "object" &&
      typeof originalClickListener === "function"
    ) {
      theHookedUpNotification.once("click", originalClickListener);
    }
  });

  ipcRenderer.send(EVENT_WEBVIEW_NOTIFICATION, {
    title,
    options,
  });

  return notificationToSend;
};
Notification.prototype = OriginalBrowserNotification.prototype;
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
Notification.permission = OriginalBrowserNotification.permission;
Notification.requestPermission = OriginalBrowserNotification.requestPermission;
