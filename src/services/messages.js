import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch
} from "firebase/firestore";
import { auth, database } from "../firebase/client.js";
import { isFirebaseConfigured, ownerUid } from "../firebase/config.js";
import { compareTimestamps } from "./conversation-state.js";
import { cleanMessage } from "./message-validation.js";

const threadReadsCollection = () => {
  if (!isFirebaseConfigured() || !database) {
    throw new Error("Conversation status is unavailable until Firebase is configured.");
  }
  return collection(database, "threadReads");
};

const typingStatesCollection = () => {
  if (!isFirebaseConfigured() || !database) {
    throw new Error("Typing status is unavailable until Firebase is configured.");
  }
  return collection(database, "typingStates");
};

const messagesCollection = () => {
  if (!isFirebaseConfigured() || !database) {
    throw new Error("Messaging is unavailable until Firebase is configured.");
  }
  return collection(database, "messages");
};

export async function sendMessage(name, text, threadId) {
  const message = cleanMessage(name, text);
  if (typeof threadId !== "string" || !threadId || threadId.length > 128) {
    throw new Error("Visitor session is not ready. Refresh and try again.");
  }
  await addDoc(messagesCollection(), {
    ...message,
    threadId,
    sender: "user",
    createdAt: serverTimestamp()
  });
}

export async function sendReply(text, threadIds) {
  const cleanText = cleanMessage("Dark", text).text;
  const recipients = [...new Set(Array.isArray(threadIds) ? threadIds : [threadIds])]
    .filter((threadId) => typeof threadId === "string" && threadId && threadId.length <= 128);
  if (!recipients.length) {
    throw new Error("Select a valid conversation.");
  }
  if (recipients.length > 450) {
    throw new Error("This name group has too many active accounts to reply to at once.");
  }

  const broadcastId = doc(messagesCollection()).id;
  const batch = writeBatch(database);
  for (const threadId of recipients) {
    const messageRef = doc(messagesCollection());
    batch.set(messageRef, {
      name: "Dark",
      text: cleanText,
      threadId,
      sender: "owner",
      broadcastId,
      createdAt: serverTimestamp()
    });
  }
  await batch.commit();
}

export function watchMessages(onMessages, onError, threadId = null) {
  const items = threadId
    ? query(messagesCollection(), where("threadId", "==", threadId))
    : query(messagesCollection(), orderBy("createdAt", "asc"));
  return onSnapshot(
    items,
    (snapshot) => {
      onMessages(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
    },
    onError
  );
}

export function watchThreadReads(onReads, onError) {
  return onSnapshot(
    threadReadsCollection(),
    (snapshot) => {
      onReads(new Map(snapshot.docs.map((item) => [item.id, item.data().lastReadAt])));
    },
    onError
  );
}

export async function markThreadRead(threadId, lastReadAt) {
  if (!auth?.currentUser || auth.currentUser.uid !== ownerUid) {
    throw new Error("Only the owner can update conversation read status.");
  }
  if (typeof threadId !== "string" || !threadId || !lastReadAt) return;

  const stateRef = doc(threadReadsCollection(), threadId);
  await runTransaction(database, async (transaction) => {
    const state = await transaction.get(stateRef);
    const currentReadAt = state.data()?.lastReadAt;
    if (currentReadAt && compareTimestamps(currentReadAt, lastReadAt) >= 0) return;

    transaction.set(stateRef, {
      lastReadAt,
      updatedAt: serverTimestamp()
    });
  });
}

export function watchTypingState(threadId, onState, onError) {
  if (typeof threadId !== "string" || !threadId) {
    throw new Error("Select a valid conversation to watch typing status.");
  }
  return onSnapshot(
    doc(typingStatesCollection(), threadId),
    (snapshot) => {
      onState(snapshot.exists() ? snapshot.data() : null);
    },
    onError
  );
}

export function watchTypingStates(threadIds, onStates, onError) {
  const uids = [...new Set(threadIds)].filter(Boolean);
  if (!uids.length) {
    onStates(new Map());
    return () => {};
  }

  const states = new Map();
  const stopWatching = uids.map((uid) => onSnapshot(
    doc(typingStatesCollection(), uid),
    (snapshot) => {
      if (snapshot.exists()) states.set(uid, snapshot.data());
      else states.delete(uid);
      onStates(new Map(states));
    },
    onError
  ));
  return () => stopWatching.forEach((stop) => stop());
}

export async function setTypingState(threadIds, sender, isTyping) {
  const uids = [...new Set(Array.isArray(threadIds) ? threadIds : [threadIds])]
    .filter((uid) => typeof uid === "string" && uid && uid.length <= 128);
  if (!uids.length) {
    throw new Error("A valid conversation is required to update typing status.");
  }
  if (sender !== "owner" && sender !== "visitor") {
    throw new Error("Invalid typing status sender.");
  }
  if (!auth?.currentUser) {
    throw new Error("A signed-in session is required to update typing status.");
  }
  if ((sender === "owner") !== (auth.currentUser.uid === ownerUid)) {
    throw new Error("The signed-in session cannot update this typing status.");
  }
  if (sender === "owner" && uids.length > 450) {
    throw new Error("This name group has too many active accounts to update typing status.");
  }

  if (sender === "visitor" && uids.some((uid) => uid !== auth.currentUser.uid)) {
    throw new Error("Visitors can only update their own typing status.");
  }

  const timestampField = `${sender}UpdatedAt`;
  await Promise.all(uids.map(async (uid) => {
    const stateRef = doc(typingStatesCollection(), uid);
    await runTransaction(database, async (transaction) => {
      const state = await transaction.get(stateRef);
      const updatedAt = serverTimestamp();
      if (state.exists()) {
        transaction.set(stateRef, {
          [sender === "owner" ? "ownerTyping" : "visitorTyping"]: isTyping,
          [timestampField]: updatedAt,
          updatedAt
        }, { merge: true });
        return;
      }

      transaction.set(stateRef, {
        visitorTyping: sender === "visitor" && isTyping,
        ownerTyping: sender === "owner" && isTyping,
        [timestampField]: updatedAt,
        updatedAt
      }, { merge: true });
    });
  }));
}
