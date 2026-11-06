import http from 'node:http';
import path from 'node:path';
import { databaseHealth } from './database.mjs';
import { createGuests } from './guests.mjs';
import { createGames } from './games.mjs';
import { createRooms } from './rooms.mjs';
import { createModelService } from './model-service.mjs';
import { createProfiles } from './profiles.mjs';
import { createLive } from './live.mjs';
import { createAnalysis } from './analysis.mjs';
import { HttpError, requireThat, checkOrigin, checkTransport } from './security.mjs';
import { createExperimentStore, RecordError } from '../scripts/experiment-store.mjs';
import { archiveRoute, serveAsset } from '../scripts/lib/web-assets.mjs';

async function readJson(req,limit=8192) {
  requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'application/json 요청이 필요합니다.');
  requireThat(!req.headers['content-length'] || Number(req.headers['content-length']) <= limit, 413, '요청이 너무 큽니다.');
  let size = 0; const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn:false })) { size += chunk.length; requireThat(size <= limit, 413, '요청이 너무 큽니다.'); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks)); requireThat(body && typeof body === 'object' && !Array.isArray(body), 400, 'JSON 객체가 필요합니다.'); return body; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, '잘못된 JSON입니다.'); }
}
export function createApplication(config, db, { now = Date.now, modelOptions, analysisOptions } = {}) {
  const guests = createGuests(db, config, now), games = createGames(db, { moveMs: config.moveMs, now });
  const models=createModelService(db,games,modelOptions);
  const analysis=createAnalysis({getModel:id=>models.getModel(id),...analysisOptions});
  const rooms = createRooms(db,games,{now,models});
  const profiles=createProfiles(db,games,models);let live;
  const store = createExperimentStore(path.join(config.root, 'artifacts'));
  let initialized=false;
  const ready=models.ready.then(()=>{rooms.cleanup();initialized=true;});
  let recoveryError = false;
  const timer = setInterval(() => { if(!initialized)return;try { games.recover();rooms.cleanup();models.tick();live?.tick();recoveryError = false; } catch { recoveryError = true; } }, 100);
  timer.unref();
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 10000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // Legacy board direction markers use inline CSS custom properties; scripts
    // remain external-only.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body)); };
    try {
      const url = new URL(req.url, config.origin);
      const pathname = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && pathname === '/health/live') { json(200, { live: true }); return; }
      if (req.method === 'GET' && pathname === '/health/ready') { requireThat(initialized&&!recoveryError, 503, '심판 복구가 지연 중입니다.'); json(200, databaseHealth(db)); return; }
      const context = checkTransport(req, config);
      if (!pathname.startsWith('/api/')) {
        requireThat(['GET','HEAD'].includes(req.method), 405, '허용하지 않는 메서드입니다.');
        await serveAsset(req, res, config.root, pathname, { arena: true }); return;
      }
      requireThat(['GET','POST'].includes(req.method), 405, '허용하지 않는 메서드입니다.');
      if (req.headers.origin !== undefined || req.method === 'POST') checkOrigin(req, config);
      requireThat(!pathname.startsWith('/api/auth/') && !pathname.startsWith('/api/admin/'),404,'API를 찾을 수 없습니다.');
      if(req.method==='POST' && pathname==='/api/guest/session') {
        const existing=guests.session(req);
        if(existing) guests.csrf(req,existing);
        json(200,guests.enter(await readJson(req),req,res,context));return;
      }
      if (pathname === '/api/me' && req.method === 'GET') {
        const s = guests.session(req); json(200, { guest:s?.guest||null,csrfToken:s?.csrf||null,guestMode:true,profile:config.profile });return;
      }
      await ready;
      const roomMatch=pathname.match(/^\/api\/rooms\/([a-f0-9-]{36})(?:\/(join|ready|leave))?$/);
      const modelMatch=pathname.match(/^\/api\/model-matches\/([a-f0-9-]{36})(?:\/games\/(\d+))?$/);
      const modelDelete=pathname.match(/^\/api\/model-matches\/([a-f0-9-]{36})\/delete$/);
      const modelDescription=pathname.match(/^\/api\/models\/([a-z0-9][a-z0-9-]*)\/description$/);
      const gameResource=pathname.match(/^\/api\/games\/([a-f0-9-]{36})(?:\/(record|actions|resign))?$/);
      if(gameResource)requireThat(!models.gameDeleted(gameResource[1]),404,'대국을 찾을 수 없습니다.');
      if(req.method==='GET') {
        if(pathname==='/api/history/me'){json(200,profiles.guest(guests.required(req).guest.id,url.searchParams));return;}
        const guestProfile=pathname.match(/^\/api\/profiles\/guests\/([a-f0-9-]{36})$/);
        const modelProfile=pathname.match(/^\/api\/profiles\/models\/([a-z0-9][a-z0-9-]*)$/);
        const replayRecord=pathname.match(/^\/api\/records\/([a-f0-9-]{36})$/);
        if(guestProfile){json(200,profiles.guest(guestProfile[1],url.searchParams));return;}
        if(modelProfile){json(200,profiles.model(modelProfile[1],url.searchParams));return;}
        if(replayRecord){json(200,profiles.record(replayRecord[1]));return;}
        if(pathname==='/api/models'){json(200,{models:models.listModels(),moveMs:60000});return;}
        if(pathname==='/api/model-matches'){json(200,models.list());return;}
        if(modelMatch){json(200,modelMatch[2]!==undefined?models.record(modelMatch[1],Number(modelMatch[2])):models.detail(modelMatch[1]));return;}
        if(pathname==='/api/rooms') {json(200,rooms.list(guests.session(req)?.guest.id));return;}
        if(roomMatch && !roomMatch[2]) {json(200,rooms.get(roomMatch[1]));return;}
        const match=pathname.match(/^\/api\/games\/([a-f0-9-]{36})(\/record)?$/);
        if(match) {json(200,match[2]?games.record(match[1]):games.get(match[1]));return;}
        if(pathname.startsWith('/api/experiments')) {json(200,await archiveRoute(pathname,store));return;}
      }
      const s = guests.required(req);
      if (req.method === 'POST') {
        guests.csrf(req, s);
        const body = await readJson(req,pathname==='/api/analysis'?32768:modelDescription?16384:8192);
        if(pathname==='/api/analysis'){
          const controller=new AbortController(),cancel=()=>controller.abort();
          res.once('close',cancel);
          try{json(200,await analysis.analyze(s.guest.id,body,{signal:controller.signal}));}
          finally{res.off('close',cancel);}
          return;
        }
        if(pathname==='/api/model-matches'){json(202,models.submit(s.guest.id,body));return;}
        if(modelDelete){requireThat(Object.keys(body).length===0,422,'삭제 요청에는 추가 설정이 필요하지 않습니다.');json(200,models.remove(modelDelete[1],s.guest.id));return;}
        if(modelDescription){json(200,models.describe(modelDescription[1],s.guest.id,body));return;}
        if(pathname==='/api/rooms') {json(201,rooms.create(s.guest.id,body));return;}
        if(roomMatch && roomMatch[2]) {
          const method=roomMatch[2];
          json(200,rooms[method](roomMatch[1],s.guest.id,body));return;
        }
        const match = pathname.match(/^\/api\/games\/([a-f0-9-]{36})\/(actions|resign)$/);
        if (match) { const reply = games.act(match[1], s.guest.id, match[2] === 'actions' ? 'action' : 'resign', body); json(reply.status, reply.body); return; }
      } else {
        if(pathname==='/api/games') {json(200,{games:games.list(s.guest.id)});return;}
      }
      throw new HttpError(404, 'API를 찾을 수 없습니다.');
    } catch (error) {
      const status = error instanceof HttpError || error instanceof RecordError ? error.status : ['ENOENT','ENOTDIR'].includes(error.code) ? 404 : [5,6].includes(error.errcode) ? 503 : error instanceof URIError ? 400 : 500;
      if (status === 429 || status === 503) res.setHeader('Retry-After', status === 429 ? '900' : '1');
      if (status === 413) res.setHeader('Connection', 'close');
      if (!res.headersSent) json(status, { error: error instanceof HttpError || status < 500 ? error.message : status === 503 ? '저장소가 사용 중입니다. 같은 요청 ID로 재시도하세요.' : '서버 처리에 실패했습니다.' });
      else res.destroy();
    }
  });
  live=createLive(server,{config,guests,games,rooms,models,isReady:()=>initialized});
  server.on('close', () => {clearInterval(timer);analysis.close();models.close();});
  return { server, games, guests, rooms, models, profiles, live, analysis, ready };
}
