// clovet-moderate-route.js — photo check for CLOVET using Sightengine.
// Needs env vars on Render: SIGHTENGINE_USER, SIGHTENGINE_SECRET
const express = require('express');

module.exports = function (app, requireAuth) {
  app.post(
    '/api/ai/moderate/image',
    requireAuth,
    express.raw({ type: '*/*', limit: '12mb' }),
    async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'no image' });
        }
        const user = process.env.SIGHTENGINE_USER;
        const key = process.env.SIGHTENGINE_SECRET;
        if (!user || !key) {
          console.error('moderate: SIGHTENGINE_USER / SIGHTENGINE_SECRET not set');
          return res.status(500).json({ error: 'moderation keys missing on server' });
        }
        const form = new FormData();
        form.append(
          'media',
          new Blob([req.body], { type: req.get('content-type') || 'image/jpeg' }),
          'upload.jpg'
        );
        form.append('models', 'nudity-2.1');
        form.append('api_user', user);
        form.append('api_secret', key);
        const r = await fetch('https://api.sightengine.com/1.0/check.json', {
          method: 'POST',
          body: form,
        });
        const data = await r.json();
        if (data.status !== 'success') {
          console.error('Sightengine error:', JSON.stringify(data));
          return res.status(502).json({ error: 'check failed' });
        }
        const n = data.nudity || {};
        const flagged =
          (n.sexual_activity || 0) > 0.5 ||
          (n.sexual_display || 0) > 0.5 ||
          (n.erotica || 0) > 0.6;
        res.json({ flagged });
      } catch (e) {
        console.error('moderate/image error:', e);
        res.status(500).json({ error: 'server error' });
      }
    }
  );
};
