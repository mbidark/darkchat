# DARK HOST

A minimal, text-only terminal for sending messages to the owner. The public page is `/`. Enter `MBI DARK` at the name prompt to open owner sign-in; `/owner.html` remains available and uses the same flow. Messages are not stored locally or reported as sent when Firebase is unavailable.

The supplied logo is used as the browser tab icon and the share-preview image. The page title and share text are both `Chat with Dark`.

## Run locally

Requires Node.js 24.12 or newer.

```sh
npm install
npm run dev
```

Open the URL printed by Vite. Firebase web app configuration is in `src/firebase/config.js`; messages can be sent once the Firestore database and rules are enabled. Owner login additionally needs the owner's Firebase Authentication email and UID. A missing Firebase response times out with an explicit unconfirmed-delivery message; it never reports success without a confirmed Firestore write.

Run the message validation tests and production build with:

```sh
npm test
npm run build
```

## Firebase setup

1. Create a Firebase project and register a web app.
2. Enable **Email/Password** and **Anonymous** sign-in providers in Firebase Authentication. Create the owner account. The password is set in Firebase, never in this repository or frontend source. Anonymous auth gives each visitor a persistent Firebase UID so the page can restore their conversation after refresh.
3. The web app's public configuration is populated in `src/firebase/config.js`. Set `ownerEmail` to the owner account's email and `ownerUid` to its Firebase Authentication UID. Firebase web config is public; do not put private service-account credentials here.
4. Create a Cloud Firestore database. Set the same owner UID in `firestore.rules`, then publish those rules. Authenticated anonymous visitors can create messages and read only their own thread; only the configured owner UID can read every thread and send replies. Both sides receive real-time updates. Publish `storage.rules` as well to keep Firebase Storage access disabled.
5. A visitor's chosen display name is preserved without an automatic numeric suffix. The owner panel groups matching names (ignoring case and repeated whitespace) into one conversation and shows the source account ID beside each visitor message. Each visitor still has a separate Firebase UID thread, so visitors cannot read one another's history. Owner replies are delivered to all active accounts in that name group and shown once in the grouped owner transcript. Removing active accounts archives their messages for the owner, disables those UIDs in chat, and makes the name available to new visitor UIDs; the Firebase Authentication accounts are not deleted. Removed visitors are signed into a fresh anonymous UID if they return on the same browser. Unread visitor messages are marked in the owner list, and both pages show live typing status. Visitor sessions automatically sign out after one hour without activity.

The interface uses a locally bundled Hack font and the configured neon-green terminal palette. Messages remain plain, left-aligned terminal text; the visitor input stays at the bottom of the conversation, and the owner and visitor transcripts follow new messages only while already scrolled to the latest message. Press Enter to send and Shift+Enter to add a line break. A blinking block cursor tracks the insertion point and remains visible when its input loses focus.

File attachments are not part of this application. Firebase Storage initialization and upload code have been removed; the included `storage.rules` deny all file access.

The visible owner-name prompt (`MBI DARK`) is a UX step, not an authorization boundary. Access is authenticated by Firebase Authentication, and Firestore rules restrict message access. Set any development password directly in Firebase Authentication; credentials must not be placed in this repository or frontend bundle.

The Firestore rules are a starter template. Review and publish them for your deployment, configure Firebase App Check and appropriate abuse controls before production use, and never deploy permissive test-mode rules.

## Build and GitHub Pages

```sh
npm run build
```

The included GitHub Actions workflow runs `npm ci` and `npm run build`, then deploys the generated `dist/` directory on pushes to `main`. In GitHub repository settings, enable Pages with **GitHub Actions** as the build and deployment source. This app uses `owner.html` as its static-compatible owner route, so GitHub Pages does not need SPA rewrite configuration. The relative asset base in `vite.config.js` supports both root and repository-subpath hosting.
