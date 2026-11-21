const html = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function actionFor(line, site) {
  const match = /^(.*?): (https?:\/\/\S+)$/.exec(line);
  if (!match) return null;
  const url = URL.parse(match[2]);
  if (!url) return null;
  if (url.origin === site && url.pathname === '/activities' && /^#access=[\w-]{32}$/.test(url.hash)) {
    return { text: 'Open Events & Workshops', url: url.href };
  }
  if (url.origin === site && /^#payment=[\w-]{32}$/.test(url.hash)) {
    return { text: 'View payment and booking status', url: url.href };
  }
  if (match[1] === 'Official Events & Workshops WhatsApp group' &&
      /^https:\/\/chat\.whatsapp\.com\/[\w-]+$/.test(url.href)) {
    return { text: 'Join the Events & Workshops WhatsApp group', url: url.href };
  }
  return null;
}

export function registrationEmail({ subject, body }, site) {
  const heading = subject.split(' | ')[1] || subject;
  const content = body.replace(/\n\nTeam Microbe Mashup ’26\nMamata Academy of Medical Sciences$/, '')
    .split('\n').filter(Boolean).map((line) => {
      const id = /^Registration ID: ((?:MMSHP|MMSPH)-\d+)$/.exec(line)?.[1];
      if (id) {
        return '<div style="background:#eef6fa;border-left:4px solid #287590;padding:12px 16px;margin:18px 0">' +
          '<div style="font-size:13px;color:#39566b">Registration ID</div>' +
          '<strong style="font-size:25px;letter-spacing:1px;color:#0c2840">' + html(id) + '</strong></div>';
      }
      const action = actionFor(line, site);
      if (action) {
        return '<p style="margin:20px 0"><a href="' + html(action.url) + '" style="display:inline-block;' +
          'background:#d7f43a;color:#101d2d;border-radius:6px;padding:13px 18px;font-weight:bold;text-decoration:none">' +
          html(action.text) + '</a></p>';
      }
      return '<p style="margin:0 0 12px;line-height:1.55">' + html(line) + '</p>';
    }).join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + html(heading) + '</title></head>' +
    '<body style="margin:0;background:#eef3f8;color:#1d3448;font:16px Arial,sans-serif">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:18px 8px">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff">' +
    '<tr><td style="background:#0b1b2b;color:#fff;padding:22px 24px;border-bottom:4px solid #d7f43a">' +
    '<strong style="color:#d7f43a;font-size:23px">Microbe Mashup ’26</strong>' +
    '<div style="color:#d4e9fa;font-size:14px;margin-top:6px">Mamata Academy of Medical Sciences</div></td></tr>' +
    '<tr><td style="padding:24px"><h1 style="font-size:24px;line-height:1.2;margin:0 0 18px;color:#0b1b2b">' +
    html(heading) + '</h1>' + content + '</td></tr>' +
    '<tr><td style="padding:15px 24px;background:#eaf1f7;font-size:13px;line-height:1.5">' +
    'Questions? Reply to this email to reach the organizing team.</td></tr></table></td></tr></table></body></html>';
}
