const cdn = 'https://www.gstatic.com/firebasejs/12.5.0/';

async function encodeSource(blob, limit) {
  if (!blob) return {};
  if (blob.size <= limit) return {sourceBytes: new Uint8Array(await blob.arrayBuffer()), sourceMime: blob.type};
  const image = new Image();
  const url = URL.createObjectURL(blob);
  try {
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    for (const dimension of [1800, 1200, 800, 600, 400]) {
      const scale = Math.min(1, dimension / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .8));
      if (jpeg?.size <= limit) {
        return {sourceBytes: new Uint8Array(await jpeg.arrayBuffer()), sourceMime: jpeg.type};
      }
    }
    throw new Error('Could not prepare the source image for sync.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function connectFirebase(config) {
  const [appSdk, authSdk, fs] = await Promise.all([
    import(cdn + 'firebase-app.js'), import(cdn + 'firebase-auth.js'), import(cdn + 'firebase-firestore.js')
  ]);
  const app = appSdk.initializeApp(config);
  const auth = authSdk.getAuth(app);
  const db = fs.initializeFirestore(app, {localCache: fs.memoryLocalCache()});
  const actions = uid => fs.collection(db, 'users', uid, 'actions');
  return {
    observe: (success, failure) => authSdk.onAuthStateChanged(auth, success, failure),
    async authenticate(mode, email, password) {
      const authenticate = mode === 'signup' ? authSdk.createUserWithEmailAndPassword : authSdk.signInWithEmailAndPassword;
      await authenticate(auth, email, password);
    },
    googleSignIn: () => authSdk.signInWithPopup(auth, new authSdk.GoogleAuthProvider()),
    signOut: () => authSdk.signOut(auth),
    watch: (uid, success, failure) => fs.onSnapshot(actions(uid), snapshot => {
      success(snapshot.docs.map(doc => {
        const {sourceBytes, sourceMime, ...item} = doc.data();
        if (sourceBytes) item.source = new Blob([sourceBytes.toUint8Array()], {type: sourceMime});
        return {...item, id: doc.id};
      }));
    }, failure),
    async save(uid, put, remove) {
      const budget = Math.min(450_000, Math.floor(5_000_000 / Math.max(1, put.filter(item => item.source).length)));
      const encoded = await Promise.all(put.map(async ({id, source, ...item}) => {
        const image = await encodeSource(source, budget);
        if (image.sourceBytes) image.sourceBytes = fs.Bytes.fromUint8Array(image.sourceBytes);
        return [id, {...item, ...image}];
      }));
      if (auth.currentUser?.uid !== uid) throw new Error('The active account changed.');
      const ref = actions(uid);
      const batch = fs.writeBatch(db);
      for (const [id, item] of encoded) batch.set(fs.doc(ref, id), item);
      for (const id of remove) batch.delete(fs.doc(ref, id));
      await batch.commit();
    }
  };
}

export function authError(error) {
  return ({
    'auth/internal-error': 'Google sign-in could not start. Reload LifeSnap in Chrome and try again.',
    'auth/web-storage-unsupported': 'Google sign-in needs browser storage. Try Chrome outside private browsing.',
    'auth/popup-closed-by-user': 'The Google sign-in window was closed.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups and try again.',
    'auth/unauthorized-domain': 'Google sign-in is unavailable on this address. Use an authorised HTTPS address or localhost.',
    'auth/operation-not-supported-in-this-environment': 'Open LifeSnap in a browser on an authorised HTTPS address.',
    'auth/account-exists-with-different-credential': 'This email already uses another sign-in method. Log in with that method.',
    'auth/invalid-credential': 'That email and password did not match.',
    'auth/email-already-in-use': 'An account already uses this email. Try logging in.',
    'auth/weak-password': 'Choose a stronger password.',
    'auth/configuration-not-found': 'Enable Email/Password in Firebase Authentication.',
    'auth/operation-not-allowed': 'Enable Email/Password in Firebase Authentication.',
    'auth/network-request-failed': 'Could not reach Firebase. Check your connection.',
    'auth/too-many-requests': 'Too many attempts. Try again later.'
  })[error.code] || 'Could not finish the request. Check the Firebase configuration and try again.';
}
