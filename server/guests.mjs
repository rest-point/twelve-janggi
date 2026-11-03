import { randomInt, randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { digest, randomToken, safeEqual, requireThat, readToken, sessionCookie } from './security.mjs';

export function createGuests(db, config, now = Date.now) {
  function session(req) {
    const token = readToken(req, config);
    if (!token) return null;
    const row = db.prepare(`SELECT u.id,u.username,s.token_hash FROM sessions s
      JOIN guests g ON g.user_id=s.user_id JOIN users u ON u.id=g.user_id
      WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND s.revoked_at IS NULL`)
      .get(digest(config.secret,'session',token), config.origin, now());
    return row ? { guest:{ id:row.id,name:row.username }, hash:row.token_hash, csrf:digest(config.secret,'csrf',token) } : null;
  }
  return {
    session,
    required(req) { const s=session(req); requireThat(s,401,'게스트 입장이 필요합니다.'); return s; },
    csrf(req,s) { requireThat(safeEqual(req.headers['x-csrf-token'],s.csrf),403,'CSRF 토큰이 일치하지 않습니다.'); },
    enter(body,req,res,context) {
      requireThat(Object.keys(body).every(k=>k==='name'),422,'이름만 입력할 수 있습니다.');
      const existing=session(req);
      if(existing) return {guest:existing.guest,csrfToken:existing.csrf};
      requireThat(body.name===undefined || typeof body.name==='string',422,'게스트 이름이 올바르지 않습니다.');
      const name=body.name?.normalize('NFKC').trim() || `게스트 ${randomInt(1000,10000)}`;
      requireThat(/^[\p{L}\p{N} _.\-]{1,20}$/u.test(name),422,'이름은 문자·숫자·공백·_·.·- 1~20자입니다.');
      const token=randomToken(),id=randomUUID(),at=now();
      const key=digest(config.secret,'guest-ip',context.clientKey);
      transaction(db,()=>{
        db.prepare('DELETE FROM auth_limits WHERE window_at<?').run(at-900000);
        const count=db.prepare('SELECT count FROM auth_limits WHERE key=?').get(key)?.count || 0;
        requireThat(count<80,429,'게스트 생성이 많습니다. 잠시 후 다시 시도하세요.');
        db.prepare('INSERT INTO auth_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,at);
        // The legacy non-null hash column is retained for data compatibility;
        // this marker is never a password and no password endpoint exists.
        db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,name,`guest:${id}`,'!guest-no-password','user',at);
        db.prepare('INSERT INTO guests VALUES(?,?)').run(id,at);
        db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(at);
        db.prepare('INSERT INTO sessions(token_hash,user_id,origin,expires_at) VALUES(?,?,?,?)')
          .run(digest(config.secret,'session',token),id,config.origin,at+604800000);
      });
      res.setHeader('Set-Cookie',sessionCookie(config,token));
      return {guest:{id,name},csrfToken:digest(config.secret,'csrf',token)};
    },
  };
}
