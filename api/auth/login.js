const TOOL_USERNAME = process.env.TOOL_USERNAME || '';
const TOOL_PASSWORD = process.env.TOOL_PASSWORD || '';

function send(res, status, data) {
  res
    .status(status)
    .setHeader('Access-Control-Allow-Origin', '*')
    .setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    .json(data);
}

function isAuthorized(req) {
  if (!TOOL_USERNAME || !TOOL_PASSWORD) return true;
  const header = req.headers?.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const [user, pass] = decoded.split(':');
    return user === TOOL_USERNAME && pass === TOOL_PASSWORD;
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  if (!TOOL_USERNAME || !TOOL_PASSWORD) {
    return send(res, 200, { ok: true, authRequired: false });
  }

  if (!isAuthorized(req)) {
    return send(res, 401, { ok: false, authRequired: true, error: 'Sai tên đăng nhập hoặc mật khẩu.' });
  }

  return send(res, 200, { ok: true, authRequired: true });
};
