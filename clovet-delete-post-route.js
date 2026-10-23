// ─────────────────────────────────────────────────────────────────────────────
// CLOVET backend: "delete post" route.
//
// Put this file in the SAME folder as server.js, then add this ONE line to
// server.js, after `app` and firebase-admin (`admin`) are set up and BEFORE
// app.listen(...):
//
//     require('./clovet-delete-post-route')(app, admin, express);
//
// (`express` is the same `require('express')` your server already uses.)
// Also add "cloudinary" to package.json dependencies (npm install cloudinary).
// Render needs: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.
// ─────────────────────────────────────────────────────────────────────────────
const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// https://res.cloudinary.com/<cloud>/<image|video|raw>/upload/[transforms/]v123/<id>.<ext>
function parseCloudinaryUrl(url) {
  const m = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video|raw)\/upload\/(?:[^/]+\/)*?v\d+\/(.+?)(\.[A-Za-z0-9]+)?$/.exec(
    String(url || '')
  );
  if (!m) return null;
  const [, cloud, resourceType, path, ext] = m;
  if (cloud !== process.env.CLOUDINARY_CLOUD_NAME) return null;
  return {
    resourceType,
    publicId: resourceType === 'raw' ? path + (ext || '') : path,
  };
}

module.exports = function registerDeletePostRoute(app, admin, express) {
  app.post('/api/posts/delete', express.json(), async (req, res) => {
    try {
      if (req.get('X-App-Secret') !== process.env.APP_SHARED_SECRET) {
        return res.status(401).json({ error: 'bad secret' });
      }
      const idToken = (req.get('Authorization') || '').replace(/^Bearer /, '');
      const decoded = await admin.auth().verifyIdToken(idToken);

      const postId = String((req.body && req.body.postId) || '');
      if (!postId) return res.status(400).json({ error: 'postId required' });

      const ref = admin.firestore().collection('posts').doc(postId);
      const snap = await ref.get();
      if (!snap.exists) return res.json({ ok: true, already: true });

      const post = snap.data();
      if (post.authorId !== decoded.uid) {
        return res.status(403).json({ error: 'not your post' });
      }

      // Every media file of the post (long videos are stored in several parts).
      const urls = new Set();
      if (post.url) urls.add(post.url);
      for (const part of post.parts || []) if (part && part.url) urls.add(part.url);

      // Erase the files first; if this throws, the post stays and the app retries.
      for (const url of urls) {
        const info = parseCloudinaryUrl(url);
        if (!info) continue;
        await cloudinary.uploader.destroy(info.publicId, {
          resource_type: info.resourceType,
          invalidate: true, // also clear the CDN copy
        });
      }

      // Then the post with its comments.
      await admin.firestore().recursiveDelete(ref);
      return res.json({ ok: true });
    } catch (e) {
      console.error('delete post failed:', e);
      return res.status(500).json({ error: 'delete failed' });
    }
  });
};
