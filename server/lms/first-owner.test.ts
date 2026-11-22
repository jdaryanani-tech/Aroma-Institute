import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import session from "express-session";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { lmsUsers, lmsUserRoles, lmsAuditLogs, lmsPasswordSetupTokens } from "@shared/lms-schema";
import { registerFirstOwnerRoutes, validBootstrapSecret } from "./first-owner";
import { registerLmsPasswordAuthRoutes } from "./password-auth";
import { hashPasswordSetupToken } from "./password-security";

test("first-owner configuration rejects absent, short, whitespace and low-diversity secrets",()=>{
  for(const value of [undefined,"","short","x".repeat(64)," "+randomBytes(32).toString("hex")])
    assert.equal(validBootstrapSecret(value),false);
  assert.equal(validBootstrapSecret(randomBytes(32).toString("base64url")),true);
});

const approved=process.env.FIRST_OWNER_TEST_DB_APPROVAL==="SOCKET_ONLY_DISPOSABLE_DATABASE";
const url=process.env.FIRST_OWNER_TEST_DATABASE_URL;
test("first-owner isolated SQL/HTTP: production gating, audit, races, rollback, expiry and single use",{
  skip:!approved||!url ? "Run npm run test:first-owner against a fresh disposable cluster." : false,
},async()=>{
  const parsed=new URL(url!);
  assert.equal(parsed.hostname,"localhost");assert.equal(parsed.pathname,"/first_owner_test");
  assert.ok(parsed.searchParams.get("host")?.includes("/generated-artifacts/first-owner-db-"));
  assert.equal(process.env.DATABASE_URL,url);
  const secret=randomBytes(48).toString("base64url");
  const phone="+12025550123";
  let config:{production:boolean;secret:string|undefined;ownerPhone:string}={production:false,secret,ownerPhone:phone};
  const app=express();app.set("trust proxy",1);app.use(express.json());
  app.use(session({secret:randomBytes(32).toString("hex"),resave:false,saveUninitialized:false}));
  registerFirstOwnerRoutes(app,{configuration:()=>config});
  registerLmsPasswordAuthRoutes(app);
  const server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
  const port=(server.address() as {port:number}).port;
  const origin=`http://127.0.0.1:${port}`;
  const headers={"Content-Type":"application/json",Host:"aromacafeinstitute.in",
    Origin:"https://aromacafeinstitute.in","X-Forwarded-Proto":"https"};
  // Node fetch replaces Host here. Raw HTTP preserves it for canonical-host checks.
  const localRequest=(path:string,body?:unknown,extraHeaders:Record<string,string>={})=>new Promise<Response>((resolve,reject)=>{
    const req=request({hostname:"127.0.0.1",port,path,method:body===undefined?"GET":"POST",headers:{...headers,...extraHeaders}},res=>{
      const chunks:Buffer[]=[];res.on("data",chunk=>chunks.push(Buffer.from(chunk)));
      res.on("end",()=>{
        const responseHeaders=new Headers();
        for(const [key,value] of Object.entries(res.headers)) {
          for(const item of Array.isArray(value)?value:[value]) if(item)responseHeaders.append(key,item);
        }
        resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:responseHeaders}));
      });
    });
    req.on("error",reject);if(body!==undefined)req.write(typeof body==="string"?body:JSON.stringify(body));req.end();
  });
  const post=(body:unknown={phone,secret,confirmOwner:true},extraHeaders:Record<string,string>={})=>
    localRequest("/api/admin/first-owner",body,extraHeaders);
  const status=()=>localRequest("/api/admin/first-owner/status");
  const reset=async()=>{
    await db.execute(sql`TRUNCATE lms_users, lms_audit_logs, lms_auth_rate_limits RESTART IDENTITY CASCADE`);
    const [student]=await db.insert(lmsUsers).values({phoneE164:"+12025550124",displayName:"Synthetic student",passwordHash:"unchanged-synthetic-marker"}).returning();
    await db.insert(lmsUserRoles).values({userId:student.id,role:"student"});
    await db.insert(lmsPasswordSetupTokens).values({userId:student.id,tokenHash:randomBytes(32).toString("hex"),expiresAt:new Date("2020-01-01")});
    return student;
  };
  const ownerRows=()=>db.select({id:lmsUsers.id,isActive:lmsUsers.isActive,passwordIsSet:sql<boolean>`${lmsUsers.passwordHash} IS NOT NULL`})
    .from(lmsUsers).where(eq(lmsUsers.phoneE164,phone));
  try {
    await reset();
    assert.equal((await post()).status,404,"development never provisions");
    config={production:true,secret:undefined,ownerPhone:phone};
    assert.equal((await status()).status,404);assert.equal((await post()).status,404);
    config={production:true,secret:"x".repeat(64),ownerPhone:phone};
    assert.equal((await post()).status,404,"weak configuration stays disabled");
    assert.equal((await ownerRows()).length,0);
    assert.equal((await db.select().from(lmsAuditLogs)).length,0,"disabled route has no writes");
    config={production:true,secret,ownerPhone:phone};
    assert.equal((await status()).status,200);
    assert.equal((await post({phone,secret:"wrong",confirmOwner:true})).status,403);
    assert.equal((await post({phone:"+12025550124",secret,confirmOwner:true})).status,400);
    assert.equal((await post({phone,secret,confirmOwner:false})).status,400);
    assert.equal((await post(undefined,{Origin:"https://untrusted.invalid"})).status,403);
    assert.equal((await post({phone:"+12025550124",secret:"wrong",confirmOwner:true})).status,403,"no phone-validation oracle before authentication");
    assert.equal((await ownerRows()).length,0);
    const failures=await db.select().from(lmsAuditLogs);
    assert.equal(failures.length,5);
    assert.ok(failures.every(a=>a.action==="bootstrap.first_owner_failed"));
    assert.ok(!JSON.stringify(failures).includes(secret));
    assert.ok(!JSON.stringify(failures).includes(phone));

    await reset();
    const malformed=await localRequest("/api/admin/first-owner",`{"secret":"${secret}" invalid`);
    assert.equal(malformed.status,400);
    assert.ok(!(await malformed.text()).includes(secret));
    const malformedAudit=await db.select().from(lmsAuditLogs);
    assert.equal(malformedAudit[0].metadata.reason,"invalid_body");
    assert.ok(!JSON.stringify(malformedAudit).includes(secret));

    await reset();
    for(let i=0;i<5;i++)assert.equal((await post({phone,secret:"wrong",confirmOwner:true})).status,403);
    assert.equal((await post()).status,429);
    assert.equal((await ownerRows()).length,0);
    assert.ok((await db.select().from(lmsAuditLogs)).some(a=>a.metadata.reason==="rate_limited"));

    await reset();
    const [existing]=await db.insert(lmsUsers).values({phoneE164:phone,displayName:"Synthetic pre-existing owner",isActive:false}).returning();
    assert.equal((await status()).status,404);
    assert.equal((await post()).status,409);
    const [unchanged]=await db.select().from(lmsUsers).where(eq(lmsUsers.id,existing.id));
    assert.equal(unchanged.isActive,false);assert.equal(unchanged.passwordHash,null);
    assert.equal((await db.select().from(lmsUserRoles).where(eq(lmsUserRoles.userId,existing.id))).length,0);

    const other=await reset();
    await db.insert(lmsUserRoles).values({userId:other.id,role:"admin"});
    assert.equal((await post()).status,409,"existing admin closes bootstrap");
    await db.delete(lmsUserRoles).where(eq(lmsUserRoles.role,"admin"));
    assert.equal((await post()).status,409,"closed marker remains permanent");
    assert.equal((await ownerRows()).length,0);

    await reset();
    await db.execute(sql`CREATE FUNCTION reject_owner_token_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic insertion failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_owner_token BEFORE INSERT ON lms_password_setup_tokens FOR EACH ROW EXECUTE FUNCTION reject_owner_token_test()`);
    assert.equal((await post()).status,503);
    assert.equal((await ownerRows()).length,0,"token failure rolls account and role back");
    assert.equal((await db.select().from(lmsUserRoles).where(eq(lmsUserRoles.role,"admin"))).length,0);
    await db.execute(sql`DROP TRIGGER reject_owner_token ON lms_password_setup_tokens`);
    await db.execute(sql`DROP FUNCTION reject_owner_token_test()`);

    const student=await reset();
    const responses=await Promise.all([post(),post()]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
    const success=responses.find(r=>r.status===201)!;
    assert.match(success.headers.get("cache-control")! ,/no-store/);
    const body=await success.json();
    assert.deepEqual(Object.keys(body).sort(),["expiresAt","maskedPhone","setupUrl"]);
    assert.equal(body.maskedPhone,"***0123");
    const setupUrl=new URL(body.setupUrl);
    assert.equal(setupUrl.origin,"https://aromacafeinstitute.in");
    assert.equal(setupUrl.pathname,"/learn/setup");assert.equal(setupUrl.search,"");
    const token=new URLSearchParams(setupUrl.hash.slice(1)).get("token")!;
    assert.ok(token.length>=40);
    const [owner]=await ownerRows();assert.equal(owner.isActive,true);assert.equal(owner.passwordIsSet,false);
    const [stored]=await db.select().from(lmsPasswordSetupTokens).where(eq(lmsPasswordSetupTokens.userId,owner.id));
    assert.equal(stored.tokenHash,hashPasswordSetupToken(token));
    assert.equal(stored.expiresAt.getTime()-stored.createdAt.getTime(),86_400_000);
    assert.equal(new Date(body.expiresAt).getTime(),stored.expiresAt.getTime());
    assert.equal((await db.select().from(lmsUserRoles).where(eq(lmsUserRoles.role,"admin"))).length,1);
    const audits=await db.select().from(lmsAuditLogs);
    assert.equal(audits.filter(a=>a.action==="bootstrap.first_owner_created").length,1);
    assert.ok(!JSON.stringify(audits).includes(token));assert.ok(!JSON.stringify(audits).includes(secret));
    const [afterStudent]=await db.select().from(lmsUsers).where(eq(lmsUsers.id,student.id));
    assert.deepEqual(afterStudent,student,"student account is untouched");
    assert.equal((await db.select().from(lmsPasswordSetupTokens).where(eq(lmsPasswordSetupTokens.userId,student.id))).length,1,"even other users' expired tokens are untouched");
    assert.equal((await post()).status,409);
    assert.equal((await status()).status,404);
    const setup=()=>fetch(`${origin}/api/lms/auth/password/setup`,{method:"POST",headers,body:JSON.stringify({token,password:"Synthetic-owner-password-24!"})});
    await db.update(lmsPasswordSetupTokens).set({expiresAt:new Date(Date.now()-1000)}).where(eq(lmsPasswordSetupTokens.id,stored.id));
    assert.equal((await setup()).status,400,"expired link fails");
    await db.update(lmsPasswordSetupTokens).set({expiresAt:stored.expiresAt}).where(eq(lmsPasswordSetupTokens.id,stored.id));
    assert.equal((await setup()).status,200,"existing setup route sets password");
    assert.equal((await setup()).status,400,"setup link is single-use");
  } finally {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await pool.end();
  }
});
