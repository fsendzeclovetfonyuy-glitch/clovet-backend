// clovet-invite-route.js
// Adds the page behind CLOVET invite links:  https://<your-render-url>/i/ABCDE23456
// Opening it on a phone with CLOVET installed jumps straight into the app's
// Join screen; otherwise it shows the code so it can be typed in.
//
// In server.js add ONE line right after `const app = express();`:
//     require('./clovet-invite-route')(app);

module.exports = function (app) {
  app.get('/i/:code', (req, res) => {
    const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 10) {
      return res.status(404).send('This invite link is not valid.');
    }
    const pretty = code.slice(0, 5) + '-' + code.slice(5);
    const appLink = 'clovet://invite/' + code;
    const intentLink =
      'intent://invite/' + code + '#Intent;scheme=clovet;end';
    res.set('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join on CLOVET</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#1A1035;color:#fff;font-family:system-ui,Segoe UI,Roboto,sans-serif;text-align:center}
  .card{padding:32px 24px;max-width:360px}
  h1{font-size:22px;margin:0 0 8px}
  p{color:#bdb6d6;font-size:15px;line-height:1.4}
  .code{font:700 28px monospace;letter-spacing:3px;margin:18px 0;color:#fff}
  a.btn{display:block;background:#7C4DFF;color:#fff;text-decoration:none;
        padding:14px;border-radius:12px;font-weight:600;margin-top:12px}
</style></head><body><div class="card">
<h1>You're invited to CLOVET</h1>
<p>Tap the button to open the invite in the CLOVET app.</p>
<a class="btn" id="open" href="${intentLink}">Open in CLOVET</a>
<p style="margin-top:22px">Not working? Open CLOVET, go to Groups &amp; Communities, tap the link icon at the top and enter this code:</p>
<div class="code">${pretty}</div>
</div>
<script>
  // Try to open the app automatically; the button is the fallback.
  setTimeout(function(){ window.location.href = ${JSON.stringify(intentLink)}; }, 400);
</script>
</body></html>`);
  });
};
