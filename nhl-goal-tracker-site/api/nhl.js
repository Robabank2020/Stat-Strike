// Relays requests to the NHL's live-stats API from Vercel's servers instead
// of the browser. The NHL API doesn't allow other websites to call it
// directly from a browser, but it has no problem with server-to-server
// requests — so this tiny function stands in between.
export default async function handler(req, res) {
  const { path } = req.query;
  if (!path || !path.startsWith("/")) {
    res.status(400).json({ error: "Missing or invalid path" });
    return;
  }
  try {
    const upstream = await fetch(`https://api-web.nhle.com${path}`);
    const data = await upstream.json();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: "Upstream request failed" });
  }
}
