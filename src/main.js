import "./style.css";
import {
  isFirebaseConfigured,
  isOwnerConfigured,
  ownerUid
} from "./firebase/config.js";
import {
  ensureVisitorSession,
  signInOwner,
  signOutOwner,
  watchAuthSession
} from "./services/auth.js";
import {
  markThreadRead,
  sendMessage,
  sendReply,
  setTypingState,
  watchMessages,
  watchThreadReads,
  watchTypingState,
  watchTypingStates
} from "./services/messages.js";
import {
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH
} from "./services/message-validation.js";
import {
  compareTimestamps,
  groupMessagesByName,
  isUnreadVisitorMessage
} from "./services/conversation-state.js";
import {
  prepareVisitorName,
  removeVisitorAccounts,
  reserveVisitorName,
  watchVisitorAccount
} from "./services/visitor-names.js";
import {
  blockCursorOffset,
  insertionPoint,
  isAllowedFocusTarget,
  isAllowedTextInput
} from "./services/input-policy.js";

const app = document.querySelector("#app");
const ownerTitle = '✿ㅤ"MʙɪㅤDᴀʀᴋ"';
const savedNameKey = "dark-host-name";
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
const cursorMeasureContext = document.createElement("canvas").getContext("2d");

let stopSessionWatch = null;
let stopMessagesWatch = null;
let stopThreadReadsWatch = null;
let stopTypingWatch = null;
let stopVisitorAccountWatch = null;
let inactivityTimer = null;
let typingTimer = null;
let typingExpiryTimer = null;
let typingWriteQueue = Promise.resolve();
let lastTypingWriteAt = 0;
let typingWatchGeneration = 0;
let messageWatchGeneration = 0;
let messages = [];
let visitorMessages = [];
const visitorNamesByUid = new Map();
const visitorActiveByUid = new Map();
const visitorNameReservationPromises = new Map();
const threadReadAtByUid = new Map();
let visitorUid = "";
let currentVisitorName = "";
let selectedThreadId = "";
let activeTypingThreadId = "";
let activeTypingThreadIds = [];
let activeTypingSender = "";
let localTypingActive = false;
let typingState = null;
let typingError = "";
let typingOtherName = "Visitor";
let visitorTypingLabel = null;
let visitorTypingDots = null;
let ownerTypingLabel = null;
let ownerTypingDots = null;
let sidebarOpen = true;
let messageError = "";
let replyError = "";
let ownerNotice = "";
let sessionExpiredNotice = "";
let deletingThreadId = "";
let lastAuthUid = "";
let visitorTranscript = null;
let visitorErrorLine = null;
let lastActivityWrite = 0;
let storageWarningShown = false;
let activeCursorUpdater = null;
let visitorFollowLatest = true;
const ownerTranscriptStates = new Map();
const ownerReplyDrafts = new Map();
let renderedOwnerThreadId = "";

function timestampMillis(value) {
  return typeof value?.toMillis === "function" ? value.toMillis() : 0;
}

function makeTypingIndicator() {
  const indicator = document.createElement("div");
  indicator.className = "typing-indicator";
  indicator.setAttribute("aria-live", "polite");
  indicator.setAttribute("aria-label", "Typing status");
  const label = document.createElement("span");
  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dots.append(dot);
  }
  indicator.append(label, dots);
  return { indicator, label, dots };
}

function refreshTypingIndicator() {
  const isOwner = Boolean(ownerTypingLabel);
  const label = isOwner ? ownerTypingLabel : visitorTypingLabel;
  const dots = isOwner ? ownerTypingDots : visitorTypingDots;
  if (!label || !dots) return;

  window.clearTimeout(typingExpiryTimer);
  typingExpiryTimer = null;
  const otherRole = isOwner ? "visitor" : "owner";
  const updatedAt = timestampMillis(typingState?.[`${otherRole}UpdatedAt`]);
  const age = Date.now() - updatedAt;
  const otherIsTyping = !typingError &&
    typingState?.[`${otherRole}Typing`] === true &&
    updatedAt > 0 && age >= 0 && age < 5_000;
  const otherName = isOwner ? typingOtherName : "Dark";
  label.textContent = otherIsTyping ? `${otherName} is typing` : "";
  label.parentElement.hidden = !otherIsTyping;
  dots.classList.toggle("active", otherIsTyping);
  if (otherIsTyping) {
    typingExpiryTimer = window.setTimeout(refreshTypingIndicator, 5_000 - age);
  }
}

function publishTypingState(isTyping) {
  const threadIds = [...activeTypingThreadIds];
  const sender = activeTypingSender;
  lastTypingWriteAt = Date.now();
  typingWriteQueue = typingWriteQueue.then(
    () => setTypingState(threadIds, sender, isTyping)
  ).catch((error) => {
    console.warn("Could not update typing status.", error);
  });
}

function clearLocalTyping() {
  window.clearTimeout(typingTimer);
  typingTimer = null;
  if (!localTypingActive || !activeTypingThreadId || !activeTypingSender) return;
  localTypingActive = false;
  publishTypingState(false);
}

function updateLocalTyping(threadId, sender, isTyping) {
  if (activeTypingThreadId !== threadId || activeTypingSender !== sender) return;
  window.clearTimeout(typingTimer);
  typingTimer = null;

  if (isTyping) {
    if (!localTypingActive) {
      localTypingActive = true;
      publishTypingState(true);
    } else if (Date.now() - lastTypingWriteAt >= 1_500) {
      publishTypingState(true);
    }
    typingTimer = window.setTimeout(clearLocalTyping, 2_000);
    return;
  }
  clearLocalTyping();
}

function watchTypingForThread(
  threadId,
  sender,
  otherName = sender === "owner" ? "Visitor" : "Dark",
  threadIds = threadId ? [threadId] : []
) {
  const sameThreadIds = activeTypingThreadIds.length === threadIds.length
    && activeTypingThreadIds.every((uid, index) => uid === threadIds[index]);
  if (activeTypingThreadId === threadId && activeTypingSender === sender && sameThreadIds) {
    typingOtherName = otherName;
    refreshTypingIndicator();
    return;
  }

  clearLocalTyping();
  window.clearTimeout(typingExpiryTimer);
  typingExpiryTimer = null;
  stopTypingWatch?.();
  stopTypingWatch = null;
  const watchGeneration = ++typingWatchGeneration;
  activeTypingThreadId = threadId;
  activeTypingThreadIds = threadIds;
  activeTypingSender = sender;
  lastTypingWriteAt = 0;
  typingState = null;
  typingError = "";
  typingOtherName = otherName;
  if (!threadId) {
    refreshTypingIndicator();
    return;
  }

  const onTypingStates = (states) => {
    if (watchGeneration !== typingWatchGeneration || activeTypingThreadId !== threadId) return;
    const now = Date.now();
    const latestTimestamp = (role) => [...states.values()].reduce((latest, state) => {
      const updatedAt = timestampMillis(state?.[`${role}UpdatedAt`] ?? state?.updatedAt);
      return state?.[`${role}Typing`] === true && updatedAt > 0 &&
        now - updatedAt >= 0 && now - updatedAt < 5_000
        ? Math.max(latest, updatedAt)
        : latest;
    }, 0);
    const visitorUpdatedAt = latestTimestamp("visitor");
    const ownerUpdatedAt = latestTimestamp("owner");
    typingState = {
      visitorTyping: visitorUpdatedAt > 0,
      visitorUpdatedAt,
      ownerTyping: ownerUpdatedAt > 0,
      ownerUpdatedAt
    };
    typingError = "";
    refreshTypingIndicator();
  };
  const onTypingError = (error) => {
    if (watchGeneration !== typingWatchGeneration || activeTypingThreadId !== threadId) return;
    typingError = error.message || "Could not load typing status.";
    console.warn("Could not load typing status.", error);
    refreshTypingIndicator();
  };
  stopTypingWatch = sender === "owner"
    ? watchTypingStates(threadIds, onTypingStates, onTypingError)
    : watchTypingState(
      threadId,
      (state) => onTypingStates(new Map(state ? [[threadId, state]] : [])),
      onTypingError
    );
}

function latestVisitorMessagesByUid() {
  const latestByUid = new Map();
  for (const message of messages) {
    if (message.sender !== "user" || !message.threadId) continue;
    const latest = latestByUid.get(message.threadId);
    if (!latest || compareTimestamps(message.createdAt, latest.createdAt) > 0) {
      latestByUid.set(message.threadId, message);
    }
  }
  return latestByUid;
}

function threadHasUnread(thread) {
  return Boolean(thread?.messages.some((message) =>
    isUnreadVisitorMessage(message, threadReadAtByUid.get(message.threadId))
  ));
}

async function markThreadAsRead(threadId) {
  const thread = getThreads().find((item) => item.id === threadId);
  if (!thread) return;
  const latestByUid = latestVisitorMessagesByUid();
  for (const uid of thread.accounts) {
    const latest = latestByUid.get(uid);
    if (!latest?.createdAt) continue;
    const currentReadAt = threadReadAtByUid.get(uid);
    if (compareTimestamps(currentReadAt, latest.createdAt) >= 0) continue;

    threadReadAtByUid.set(uid, latest.createdAt);
    try {
      await markThreadRead(uid, latest.createdAt);
      if (ownerNotice.startsWith("Could not save the read status.")) {
        ownerNotice = "";
      }
    } catch (error) {
      ownerNotice = `Could not save the read status. ${error.message || ""}`;
    }
  }
  showOwnerInterface();
}

function readSavedName() {
  try {
    return localStorage.getItem(savedNameKey) || "";
  } catch (error) {
    console.warn("Could not read the saved visitor name.", error);
    return "";
  }
}

function saveVisitorName(name) {
  try {
    localStorage.setItem(savedNameKey, name);
  } catch (error) {
    console.warn("Could not save the visitor name.", error);
  }
}

function clearSavedName() {
  try {
    localStorage.removeItem(savedNameKey);
  } catch (error) {
    console.warn("Could not clear the saved visitor name.", error);
  }
}

function activityKey(uid) {
  return `dark-host-last-activity:${uid}`;
}

function readLastActivity(uid) {
  try {
    const value = Number(localStorage.getItem(activityKey(uid)));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    warnStorageOnce("Could not read the visitor activity time.", error);
    return 0;
  }
}

function writeLastActivity(uid, timestamp) {
  try {
    localStorage.setItem(activityKey(uid), String(timestamp));
  } catch (error) {
    warnStorageOnce("Could not save the visitor activity time.", error);
  }
}

function removeLastActivity(uid) {
  try {
    localStorage.removeItem(activityKey(uid));
  } catch (error) {
    warnStorageOnce("Could not clear the visitor activity time.", error);
  }
}

function warnStorageOnce(message, error) {
  if (storageWarningShown) return;
  storageWarningShown = true;
  console.warn(message, error);
}

function stopInactivityTimer() {
  window.clearTimeout(inactivityTimer);
  inactivityTimer = null;
}

function scheduleInactivityLogout(uid, lastActivity) {
  stopInactivityTimer();
  if (uid !== visitorUid || !uid || uid === ownerUid) return;

  const remaining = INACTIVITY_TIMEOUT_MS - (Date.now() - lastActivity);
  if (remaining <= 0) {
    void expireVisitorSession(uid);
    return;
  }
  inactivityTimer = window.setTimeout(() => {
    void expireVisitorSession(uid);
  }, remaining);
}

function recordVisitorActivity() {
  if (!visitorUid || visitorUid === ownerUid) return;
  const now = Date.now();
  if (now - lastActivityWrite < 1_000) return;
  scheduleInactivityLogout(visitorUid, now);
  if (now - lastActivityWrite >= 10_000) {
    writeLastActivity(visitorUid, now);
    lastActivityWrite = now;
  }
}

async function expireVisitorSession(uid) {
  if (uid !== visitorUid || uid === ownerUid) return;
  stopInactivityTimer();
  clearSavedName();
  removeLastActivity(uid);
  visitorUid = "";
  sessionExpiredNotice = "You were signed out after one hour of inactivity. Enter your name to continue.";
  try {
    await signOutOwner();
  } catch (error) {
    visitorUid = uid;
    scheduleInactivityLogout(uid, Date.now());
    showMessagePrompt(currentVisitorName);
    if (visitorErrorLine) {
      visitorErrorLine.className = "line error";
      visitorErrorLine.textContent = error.message || "Could not sign out after inactivity.";
    }
  }
}

function stopMessageWatch() {
  messageWatchGeneration += 1;
  stopMessagesWatch?.();
  stopMessagesWatch = null;
  stopThreadReadsWatch?.();
  stopThreadReadsWatch = null;
  stopVisitorAccountWatch?.();
  stopVisitorAccountWatch = null;
  clearLocalTyping();
  window.clearTimeout(typingExpiryTimer);
  typingExpiryTimer = null;
  stopTypingWatch?.();
  stopTypingWatch = null;
  typingWatchGeneration += 1;
  activeTypingThreadId = "";
  activeTypingThreadIds = [];
  activeTypingSender = "";
  localTypingActive = false;
  typingState = null;
}

function pause(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function focusForDesktop(input) {
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    input.focus();
  }
}

function makeLine(text = "", className = "") {
  const line = document.createElement("div");
  line.className = `line ${className}`.trim();
  line.textContent = text;
  return line;
}

function makeInput(label, value = "", type = "text") {
  const row = document.createElement("div");
  row.className = `input-row${label === "whats your name ?" ? " name-prompt-row" : ""}`;

  const labelNode = document.createElement("label");
  labelNode.className = "prompt";
  labelNode.textContent = label;

  const isTextarea = type === "textarea";
  const input = document.createElement(isTextarea ? "textarea" : "input");
  input.className = "terminal-input";
  if (!isTextarea) input.type = type;
  input.dataset.chatInput = "true";
  if (!isTextarea) input.autocomplete = type === "password" ? "current-password" : "off";
  input.spellcheck = false;
  input.value = value;
  input.setAttribute("aria-label", label.replace(/:\s*$/, ""));
  if (isTextarea) {
    input.rows = 1;
    input.addEventListener("input", () => resizeComposer(input));
  }
  labelNode.append(input);
  row.append(labelNode);

  input.addEventListener("input", () => {
    row.classList.toggle("has-value", input.value.length > 0);
  });
  attachBlockCursor(input);

  return { row, input };
}

function resizeComposer(input) {
  input.style.height = "auto";
  const maxHeight = Number.parseFloat(window.getComputedStyle(input).maxHeight);
  const nextHeight = Number.isFinite(maxHeight)
    ? Math.min(input.scrollHeight, maxHeight)
    : input.scrollHeight;
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > nextHeight ? "auto" : "hidden";
}

function attachBlockCursor(input) {
  const prompt = input.parentElement;
  const cursor = document.createElement("span");
  cursor.className = "block-cursor";
  cursor.textContent = "█";
  cursor.setAttribute("aria-hidden", "true");
  prompt.classList.add("input-prompt");
  prompt.append(cursor);

  const mirror = input.tagName === "TEXTAREA"
    ? document.createElement("div")
    : null;
  const marker = mirror ? document.createElement("span") : null;
  if (mirror && marker) {
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.cssText = [
      "position:fixed",
      "top:0",
      "left:-10000px",
      "visibility:hidden",
      "pointer-events:none",
      "overflow:hidden",
      "height:auto",
      "min-height:0",
      "max-height:none",
      "white-space:pre-wrap",
      "overflow-wrap:anywhere",
      "word-break:break-word"
    ].join(";");
    marker.textContent = "\u200b";
    mirror.append(marker);
    prompt.append(mirror);
  }

  let frame = 0;
  const updatePosition = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (!input.isConnected) return;
      const selection = insertionPoint(input);
      const inputStyle = window.getComputedStyle(input);
      const inputRect = input.getBoundingClientRect();
      const promptRect = prompt.getBoundingClientRect();
      if (mirror && marker) {
        const copiedProperties = [
          "font", "lineHeight", "letterSpacing", "wordSpacing", "textTransform",
          "textIndent", "textAlign", "paddingTop", "paddingRight", "paddingBottom",
          "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
          "borderLeftWidth", "boxSizing", "direction", "tabSize"
        ];
        for (const property of copiedProperties) {
          mirror.style[property] = inputStyle[property];
        }
        mirror.style.width = `${inputRect.width}px`;
        const prefix = input.value.slice(0, selection);
        mirror.replaceChildren(document.createTextNode(prefix), marker);
        const markerRect = marker.getBoundingClientRect();
        cursor.style.left = `${markerRect.left - promptRect.left - input.scrollLeft}px`;
        cursor.style.top = `${markerRect.top - promptRect.top - input.scrollTop}px`;
      } else {
        if (cursorMeasureContext) {
          cursorMeasureContext.font = inputStyle.font;
        }
        const selectedText = input.type === "password"
          ? "•".repeat(selection)
          : input.value.slice(0, selection);
        const letterSpacing = Number.parseFloat(inputStyle.letterSpacing) || 0;
        const textWidth = cursorMeasureContext
          ? cursorMeasureContext.measureText(selectedText).width +
            Math.max(0, [...selectedText].length - 1) * letterSpacing
          : 0;
        const leftInset = Number.parseFloat(inputStyle.paddingLeft) +
          Number.parseFloat(inputStyle.borderLeftWidth);
        cursor.style.left = `${blockCursorOffset(
          inputRect,
          promptRect,
          textWidth + (Number.isFinite(leftInset) ? leftInset : 0),
          input.scrollLeft
        )}px`;
        cursor.style.top = `${inputRect.top - promptRect.top}px`;
      }
    });
  };

  activeCursorUpdater = updatePosition;
  input.addEventListener("focus", () => {
    activeCursorUpdater = updatePosition;
    updatePosition();
  });
  for (const eventName of [
    "input", "select", "keyup", "click", "pointerup", "scroll", "compositionend"
  ]) {
    input.addEventListener(eventName, updatePosition);
  }
  updatePosition();
}

async function startup() {
  app.replaceChildren();
  app.className = "startup";
  const output = document.createElement("div");
  output.className = "startup-output";
  app.append(output);

  const lines = [
    "Initializing DARK HOST...",
    "Loading terminal...",
    "Establishing secure channel...",
    "Initialization complete."
  ];
  for (const text of lines) {
    const line = makeLine();
    const content = document.createTextNode("");
    line.append(content);
    output.append(line);
    for (const character of text) {
      content.data += character;
      await pause(8);
    }
    await pause(text.startsWith("Initialization") ? 100 : 75);
  }
  app.className = "";
}

function showNamePrompt(errorText = "") {
  app.replaceChildren();
  app.className = "terminal";
  const { row, input } = makeInput("whats your name ?");
  input.maxLength = MAX_NAME_LENGTH;
  const status = makeLine(errorText, errorText ? "error" : "");
  status.setAttribute("role", "status");
  app.append(row);
  app.append(status);
  focusForDesktop(input);
  row.addEventListener("click", () => input.focus());
  input.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    let name;
    try {
      name = prepareVisitorName(input.value);
    } catch (error) {
      status.className = "line error";
      status.textContent = error.message;
      return;
    }
    if (name.replace(/\s+/g, " ").toUpperCase() === "MBI DARK") {
      showOwnerPasswordPrompt();
      return;
    }
    input.disabled = true;
    status.className = "line status";
    status.textContent = "Checking name...";
    const uid = visitorUid;
    try {
      const assignment = await reserveVisitorName(name, uid);
      if (visitorUid !== uid) return;
      currentVisitorName = assignment.name;
      saveVisitorName(assignment.name);
      showMessagePrompt(assignment.name);
      startMessageListener(false, visitorUid);
    } catch (error) {
      if (error.message?.includes("This account was removed from chat.")) {
        saveVisitorName(name);
        try {
          await signOutOwner();
        } catch (signOutError) {
          status.className = "line error";
          status.textContent = signOutError.message || "Could not create a fresh visitor session.";
          input.disabled = false;
          input.focus();
        }
        return;
      }
      status.className = "line error";
      status.textContent = error.message || "Could not reserve that name.";
      input.disabled = false;
      input.focus();
    }
  });
}

function isAtLatest(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= 48;
}

function showMessagePrompt(name) {
  currentVisitorName = name;
  visitorFollowLatest = true;
  app.replaceChildren();
  app.className = "terminal visitor-chat";
  app.append(makeLine("olny way to the dark"));

  visitorTranscript = document.createElement("div");
  visitorTranscript.className = "visitor-transcript";
  visitorTranscript.setAttribute("aria-live", "polite");
  visitorTranscript.addEventListener("scroll", () => {
    visitorFollowLatest = isAtLatest(visitorTranscript);
  });
  const typing = makeTypingIndicator();
  visitorTypingLabel = typing.label;
  visitorTypingDots = typing.dots;
  typingOtherName = "Dark";
  ownerTypingLabel = null;
  ownerTypingDots = null;
  app.append(typing.indicator);
  app.append(visitorTranscript);
  visitorErrorLine = makeLine(messageError, messageError ? "error" : "");
  visitorErrorLine.setAttribute("role", "status");
  app.append(visitorErrorLine);
  watchTypingForThread(visitorUid, "visitor");
  refreshTypingIndicator();
  renderVisitorTranscript();

  const addComposer = () => {
    const entry = document.createElement("div");
    entry.className = "message-entry";
    const { row, input } = makeInput("", "", "textarea");
    input.classList.add("chat-input");
    input.maxLength = MAX_MESSAGE_LENGTH;
    input.setAttribute("aria-label", "Message");
    input.addEventListener("input", () => {
      updateLocalTyping(visitorUid, "visitor", Boolean(input.value.trim()));
    });
    const status = makeLine();
    status.setAttribute("role", "status");
    entry.append(row, status);
    app.append(entry);
    resizeComposer(input);
    focusForDesktop(input);
    row.addEventListener("click", () => input.focus());
    input.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      const text = input.value.trim();
      if (!text || input.disabled) return;
      input.disabled = true;
      updateLocalTyping(visitorUid, "visitor", false);
      let timeoutId;
      try {
        await Promise.race([
          sendMessage(name, text, visitorUid),
          new Promise((_, reject) => {
            timeoutId = window.setTimeout(
              () => reject(new Error("No confirmation from Firebase. Delivery is unconfirmed; check your connection before retrying.")),
              20000
            );
          })
        ]);
        entry.remove();
        addComposer();
      } catch (error) {
        status.className = "line status error";
        status.textContent = error.message || "Message could not be sent.";
        input.disabled = false;
        focusForDesktop(input);
      } finally {
        window.clearTimeout(timeoutId);
      }
    });
  };
  addComposer();
}

function createChatMessage(message, threadName = "", showSource = false) {
  const isOwner = message.sender === "owner";
  const article = document.createElement("article");
  article.className = `chat-message ${isOwner ? "from-owner" : "from-user"}`;

  const senderName = isOwner ? "Dark" : threadName || message.name || "User";

  const content = document.createElement("div");
  content.className = "chat-content";
  content.append(document.createTextNode(`${senderName}: `), document.createTextNode(message.text || ""));

  article.append(content);
  if (showSource && message.sender === "user" && message.threadId) {
    const source = makeLine(`Source account: ${message.threadId}`, "message-source-id");
    article.append(source);
  }
  return article;
}

function renderVisitorTranscript() {
  if (!visitorTranscript) return;
  const shouldFollow = visitorFollowLatest;
  visitorTranscript.replaceChildren();
  for (const message of visitorMessages) {
    visitorTranscript.append(createChatMessage(message, currentVisitorName));
  }
  if (shouldFollow) visitorTranscript.scrollTop = visitorTranscript.scrollHeight;
}

function showOwnerPasswordPrompt() {
  app.replaceChildren();
  app.className = "terminal";
  const { row, input } = makeInput("Enter password:", "", "password");
  const status = makeLine();
  status.setAttribute("role", "status");
  if (!isOwnerConfigured()) {
    status.className = "line error";
    status.textContent = "Owner login not configured. Add the Firebase owner email and UID.";
  }
  app.append(row, status);
  focusForDesktop(input);
  row.addEventListener("click", () => input.focus());
  input.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!input.value) return;
    input.disabled = true;
    status.className = "line status";
    status.textContent = "Authenticating...";
    try {
      await signInOwner(input.value);
      app.replaceChildren();
      app.className = "terminal";
      app.append(makeLine(`Welcome ${ownerTitle}`));
      await pause(450);
      if (lastAuthUid === ownerUid) showOwnerInterface();
    } catch (error) {
      status.className = "line error";
      status.textContent = error.message || "Authentication failed.";
      input.value = "";
      input.disabled = false;
      input.focus();
    }
  });
}

function getThreads() {
  return groupMessagesByName(messages, visitorNamesByUid, visitorActiveByUid);
}

async function ensureVisitorNames(currentMessages) {
  const names = new Map();
  for (const message of currentMessages) {
    if (message.sender === "user" && message.threadId && message.name && !names.has(message.threadId)) {
      names.set(message.threadId, message.name);
    }
  }

  const failures = [];
  await Promise.all([...names].map(async ([uid, name]) => {
    if (visitorNamesByUid.has(uid) && visitorActiveByUid.has(uid)) return;
    try {
      const existingReservation = visitorNameReservationPromises.get(uid);
      if (existingReservation) {
        await existingReservation;
        return;
      }

      const reservation = reserveVisitorName(name, uid)
        .then((assignment) => {
          visitorNamesByUid.set(uid, assignment.name);
          visitorActiveByUid.set(uid, assignment.active);
        })
        .finally(() => {
          visitorNameReservationPromises.delete(uid);
        });
      visitorNameReservationPromises.set(uid, reservation);
      await reservation;
    } catch (error) {
      failures.push(error);
    }
  }));
  if (failures.length) {
    console.warn("Some existing visitor names could not be reserved.", failures);
    ownerNotice = `Could not reserve every existing name. Publish the current Firestore rules. ${failures[0].message || ""}`;
  } else if (ownerNotice.startsWith("Could not reserve every existing name.")) {
    ownerNotice = "";
  }
}

function showOwnerInterface() {
  const previousReply = app.querySelector(".owner-reply-composer .chat-input");
  const previousReplyFocused = previousReply && document.activeElement === previousReply;
  if (previousReply && renderedOwnerThreadId && !previousReply.disabled) {
    ownerReplyDrafts.set(renderedOwnerThreadId, {
      value: previousReply.value,
      selectionStart: previousReply.selectionStart,
      selectionEnd: previousReply.selectionEnd,
      scrollTop: previousReply.scrollTop
    });
  }
  app.replaceChildren();
  app.className = `owner-layout${sidebarOpen ? "" : " sidebar-closed"}`;

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  sidebar.setAttribute("aria-label", "Users");

  const createToggle = () => {
    const toggle = document.createElement("button");
    toggle.className = "text-control owner-toggle";
    toggle.type = "button";
    toggle.textContent = ownerTitle;
    toggle.setAttribute("aria-expanded", String(sidebarOpen));
    toggle.addEventListener("click", () => {
      sidebarOpen = !sidebarOpen;
      showOwnerInterface();
    });
    return toggle;
  };

  const userList = document.createElement("nav");
  userList.className = "user-list";
  userList.setAttribute("aria-label", "Message senders");
  const threads = getThreads();
  for (const thread of threads) {
    const entry = document.createElement("button");
    entry.className = `text-control user-entry${selectedThreadId === thread.id ? " selected" : ""}`;
    entry.type = "button";
    entry.title = `${thread.accounts.size} account${thread.accounts.size === 1 ? "" : "s"}`;
    entry.setAttribute("aria-label", `${thread.name}, ${entry.title}`);
    const name = document.createElement("span");
    name.className = "user-entry-name";
    name.textContent = thread.name;
    entry.append(name);
    if (threadHasUnread(thread)) {
      const unreadDot = document.createElement("span");
      unreadDot.className = "unread-dot";
      unreadDot.setAttribute("aria-label", "Unread messages");
      unreadDot.setAttribute("role", "img");
      entry.append(unreadDot);
    }
    entry.addEventListener("click", () => {
      selectedThreadId = thread.id;
      replyError = "";
      ownerNotice = "";
      void markThreadAsRead(thread.id);
      showOwnerInterface();
    });
    userList.append(entry);
  }

  const logout = document.createElement("button");
  logout.className = "text-control logout";
  logout.type = "button";
  logout.textContent = "Logout";
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    try {
      clearSavedName();
      await signOutOwner();
    } catch (error) {
      logout.disabled = false;
      main.replaceChildren(makeLine(error.message || "Could not log out.", "error"));
    }
  });
  if (sidebarOpen) sidebar.append(createToggle());
  sidebar.append(userList, logout);

  const main = document.createElement("section");
  main.className = "owner-main";
  main.setAttribute("aria-label", "Selected messages");
  if (!sidebarOpen) main.append(createToggle());
  const thread = threads.find((item) => item.id === selectedThreadId);
  const currentMessages = thread?.messages || [];
  const typing = makeTypingIndicator();
  ownerTypingLabel = typing.label;
  ownerTypingDots = typing.dots;
  visitorTypingLabel = null;
  visitorTypingDots = null;
  typingOtherName = thread?.name || "Visitor";
  main.append(typing.indicator);
  watchTypingForThread(
    thread?.id || "",
    "owner",
    thread?.name || "Visitor",
    thread ? [...thread.activeAccounts] : []
  );
  refreshTypingIndicator();
  if (thread) {
    main.append(makeLine(thread.name, "conversation-title"));
    main.append(makeLine(
      `Source account IDs: ${[...thread.accounts].join(", ")}`,
      "account-id"
    ));
    const removeAccount = document.createElement("button");
    removeAccount.className = "text-control remove-account";
    removeAccount.type = "button";
    removeAccount.textContent = "Remove active accounts";
    removeAccount.disabled = deletingThreadId === thread.id || !thread.activeAccounts.size;
    removeAccount.addEventListener("click", async () => {
      if (deletingThreadId === thread.id || !thread.activeAccounts.size) return;
      if (!window.confirm(
        `Remove all ${thread.activeAccounts.size} active account(s) named ${thread.name} from chat? ` +
        "Their message history will be archived for the owner, and the name can be reused. " +
        "This does not delete their Firebase sign-in accounts."
      )) {
        return;
      }
      deletingThreadId = thread.id;
      removeAccount.disabled = true;
      try {
        const accountIds = [...thread.activeAccounts];
        const count = await removeVisitorAccounts(accountIds);
        if (lastAuthUid !== ownerUid) return;
        for (const uid of accountIds) visitorActiveByUid.set(uid, false);
        selectedThreadId = getThreads().find((item) => item.id === thread.id)?.id
          || getThreads()[0]?.id
          || "";
        replyError = "";
        ownerNotice = `Removed ${count} account(s). Their messages are archived and ${thread.name} is available again.`;
        deletingThreadId = "";
        showOwnerInterface();
      } catch (error) {
        if (lastAuthUid !== ownerUid) return;
        replyError = "";
        ownerNotice = `Could not remove visitor account. ${error.message || ""}`;
        deletingThreadId = "";
        showOwnerInterface();
      }
    });
    main.append(removeAccount);
    const transcript = document.createElement("div");
    transcript.className = "owner-transcript";
    for (const message of currentMessages) {
      transcript.append(createChatMessage(message, thread.name, true));
    }
    const transcriptState = ownerTranscriptStates.get(thread.id) || {
      scrollTop: 0,
      followLatest: true
    };
    transcript.addEventListener("scroll", () => {
      ownerTranscriptStates.set(thread.id, {
        scrollTop: transcript.scrollTop,
        followLatest: isAtLatest(transcript)
      });
    });
    window.requestAnimationFrame(() => {
      if (!transcript.isConnected) return;
      transcript.scrollTop = transcriptState.followLatest
        ? transcript.scrollHeight
        : transcriptState.scrollTop;
    });
    main.append(transcript);

    if (!thread.activeAccounts.size) {
      main.append(makeLine("No active accounts in this archive. The name is available to new accounts.", "status"));
      if (!isFirebaseConfigured()) {
        main.append(makeLine("Firebase is not configured. Owner messages are unavailable.", "error"));
      } else if (messageError) {
        main.append(makeLine(messageError, "error"));
      }
      if (ownerNotice) main.append(makeLine(ownerNotice, "status"));
      app.append(sidebar, main);
      renderedOwnerThreadId = thread.id;
      return;
    }

    const reply = document.createElement("div");
    reply.className = "owner-reply-composer";
    const draft = ownerReplyDrafts.get(thread.id);
    const { row, input } = makeInput("", draft?.value || "", "textarea");
    input.classList.add("chat-input");
    input.maxLength = MAX_MESSAGE_LENGTH;
    input.setAttribute("aria-label", "Reply");
    input.addEventListener("input", () => {
      ownerReplyDrafts.set(thread.id, {
        value: input.value,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        scrollTop: input.scrollTop
      });
    });
    input.addEventListener("scroll", () => {
      const savedDraft = ownerReplyDrafts.get(thread.id);
      if (savedDraft) ownerReplyDrafts.set(thread.id, {
        ...savedDraft,
        scrollTop: input.scrollTop
      });
    });
    input.addEventListener("input", () => {
      updateLocalTyping(thread.id, "owner", Boolean(input.value.trim()));
    });
    const status = makeLine(replyError, replyError ? "error" : "");
    status.setAttribute("role", "status");
    row.addEventListener("click", () => input.focus());
    input.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const text = input.value.trim();
      if (!text || input.disabled) return;
      input.disabled = true;
      updateLocalTyping(thread.id, "owner", false);
      let timeoutId;
      try {
        await Promise.race([
          sendReply(text, [...thread.activeAccounts]),
          new Promise((_, reject) => {
            timeoutId = window.setTimeout(
              () => reject(new Error("No confirmation from Firebase. Delivery is unconfirmed; check your connection before retrying.")),
              20_000
            );
          })
        ]);
        replyError = "";
        ownerReplyDrafts.delete(thread.id);
        showOwnerInterface();
      } catch (error) {
        replyError = error.message || "Reply could not be sent.";
        status.className = "line error";
        status.textContent = replyError;
        input.disabled = false;
        input.focus();
      } finally {
        window.clearTimeout(timeoutId);
      }
    });
    reply.append(row, status);
    main.append(reply);
    resizeComposer(input);
    if (draft) {
      input.setSelectionRange(draft.selectionStart, draft.selectionEnd);
      input.scrollTop = draft.scrollTop || 0;
    }
    if (previousReplyFocused && renderedOwnerThreadId === thread.id) {
      input.focus();
      if (draft) {
        input.setSelectionRange(draft.selectionStart, draft.selectionEnd);
        input.scrollTop = draft.scrollTop || 0;
      }
    }
  } else {
    main.append(makeLine("Select a user."));
  }
  if (!isFirebaseConfigured()) {
    main.append(makeLine("Firebase is not configured. Owner messages are unavailable.", "error"));
  } else if (messageError) {
    main.append(makeLine(messageError, "error"));
  }
  if (ownerNotice) main.append(makeLine(ownerNotice, "status"));
  app.append(sidebar, main);
  renderedOwnerThreadId = thread?.id || "";
}

function startMessageListener(isOwner, threadId) {
  stopMessageWatch();
  const generation = messageWatchGeneration;
  messageError = "";
  stopMessagesWatch = watchMessages(
    async (nextMessages) => {
      if (generation !== messageWatchGeneration) return;
      messageError = "";
      if (isOwner) {
        messages = nextMessages;
        await ensureVisitorNames(nextMessages);
        if (generation !== messageWatchGeneration) return;
        if (!getThreads().some((thread) => thread.id === selectedThreadId)) {
          selectedThreadId = getThreads()[0]?.id || "";
        }
        if (selectedThreadId) void markThreadAsRead(selectedThreadId);
        showOwnerInterface();
      } else {
        visitorMessages = nextMessages.sort((a, b) =>
          (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0)
        );
        if (visitorErrorLine) {
          visitorErrorLine.className = "line";
          visitorErrorLine.textContent = "";
        }
        renderVisitorTranscript();
      }
    },
    (error) => {
      if (generation !== messageWatchGeneration) return;
      messageError = error.message || "Could not load messages.";
      if (isOwner) showOwnerInterface();
      else {
        const savedName = readSavedName();
        if (savedName) showMessagePrompt(savedName);
        else showNamePrompt(messageError);
      }
    },
    threadId
  );
  if (isOwner) {
    stopThreadReadsWatch = watchThreadReads(
      (reads) => {
        if (generation !== messageWatchGeneration) return;
        threadReadAtByUid.clear();
        for (const [uid, readAt] of reads) threadReadAtByUid.set(uid, readAt);
        showOwnerInterface();
      },
      (error) => {
        if (generation !== messageWatchGeneration) return;
        ownerNotice = `Could not load unread statuses. ${error.message || ""}`;
        showOwnerInterface();
      }
    );
  } else {
    stopVisitorAccountWatch = watchVisitorAccount(
      threadId,
      (profile) => {
        if (profile?.active === true) return;
        stopVisitorAccountWatch?.();
        stopVisitorAccountWatch = null;
        void signOutOwner().catch((error) => {
          if (lastAuthUid !== threadId || !visitorErrorLine) return;
          visitorErrorLine.className = "line error";
          visitorErrorLine.textContent = error.message || "Could not start a fresh visitor account.";
        });
      },
      (error) => {
        if (generation !== messageWatchGeneration) return;
        console.warn("Could not monitor visitor account status.", error);
        if (visitorErrorLine) {
          visitorErrorLine.className = "line error";
          visitorErrorLine.textContent = `Account status unavailable. ${error.message || ""}`;
        }
      }
    );
    watchTypingForThread(threadId, "visitor");
  }
}

async function handleAuthChange(user) {
  if (user?.uid === lastAuthUid) return;
  lastAuthUid = user?.uid || "";
  visitorUid = "";
  currentVisitorName = "";
  stopInactivityTimer();
  messages = [];
  visitorMessages = [];
  threadReadAtByUid.clear();
  deletingThreadId = "";
  visitorErrorLine = null;
  stopMessageWatch();

  if (user?.uid === ownerUid) {
    startMessageListener(true);
    showOwnerInterface();
    return;
  }

  if (user) {
    visitorUid = user.uid;
    const lastActivity = readLastActivity(user.uid) || Date.now();
    lastActivityWrite = lastActivity;
    writeLastActivity(user.uid, lastActivity);
    scheduleInactivityLogout(user.uid, lastActivity);
    if (visitorUid !== user.uid) return;
    const savedName = readSavedName();
    if (savedName) {
      try {
        const assignment = await reserveVisitorName(savedName, user.uid);
        if (lastAuthUid !== user.uid) return;
        currentVisitorName = assignment.name;
        saveVisitorName(assignment.name);
        showMessagePrompt(assignment.name);
        startMessageListener(false, user.uid);
      } catch (error) {
        if (lastAuthUid !== user.uid) return;
        if (error.message?.includes("This account was removed from chat.")) {
          try {
            await signOutOwner();
          } catch (signOutError) {
            showNamePrompt(signOutError.message || "Could not create a fresh visitor session.");
          }
          return;
        }
        showNamePrompt(error.message || "Could not reserve that name.");
      }
    } else {
      const notice = sessionExpiredNotice;
      sessionExpiredNotice = "";
      showNamePrompt(notice);
    }
    return;
  }

  try {
    await ensureVisitorSession();
  } catch (error) {
    const notice = sessionExpiredNotice;
    sessionExpiredNotice = "";
    showNamePrompt(notice || error.message || "Visitor session unavailable.");
  }
}

async function boot() {
  await startup();
  const updateViewportLayout = () => {
    activeCursorUpdater?.();
    if (visitorTranscript && visitorFollowLatest) {
      visitorTranscript.scrollTop = visitorTranscript.scrollHeight;
    }
    const ownerTranscript = app.querySelector(".owner-transcript");
    const ownerState = ownerTranscriptStates.get(renderedOwnerThreadId);
    if (ownerTranscript && (ownerState?.followLatest ?? true)) {
      ownerTranscript.scrollTop = ownerTranscript.scrollHeight;
    }
  };
  window.addEventListener("resize", updateViewportLayout);
  window.visualViewport?.addEventListener("resize", updateViewportLayout);
  window.visualViewport?.addEventListener("scroll", updateViewportLayout);
  void document.fonts?.ready.then(() => activeCursorUpdater?.());
  document.addEventListener("selectionchange", () => {
    if (document.activeElement?.dataset?.chatInput === "true") activeCursorUpdater?.();
  });
  document.addEventListener("focusin", (event) => {
    if (isAllowedFocusTarget(event.target)) return;
    event.target.blur?.();
  });
  for (const eventName of ["beforeinput", "paste", "drop"]) {
    document.addEventListener(eventName, (event) => {
      if (!isAllowedTextInput(event.target)) event.preventDefault();
    }, true);
  }
  document.addEventListener("keydown", (event) => {
    if (isAllowedTextInput(event.target)) return;
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
    }
  }, true);
  for (const eventName of ["pointerdown", "keydown", "input", "touchstart", "scroll"]) {
    document.addEventListener(eventName, recordVisitorActivity, { passive: true });
  }
  document.addEventListener("pointermove", recordVisitorActivity, { passive: true });
  stopSessionWatch = watchAuthSession(handleAuthChange);
}

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  stopMessageWatch();
  stopSessionWatch?.();
});

boot();
