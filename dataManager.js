import { getMongoDatabase } from './mongo.js';
import { normalizeOwnedContinents } from './utils/continentLooker.js';
import { normalizeUserPreferences } from './utils/userPreferences.js';
import mineRegionsJson from './config/mineRegions.json' with { type: 'json' };
import continentDataJson from './config/continentData.json' with { type: 'json' };
import { AsyncLocalStorage } from 'node:async_hooks';
const mineRegions = mineRegionsJson.regions || [], continentData = continentDataJson.continents || [];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const snapshot = Symbol('idleMinerUserSnapshot');
const isDiscordId = id => /^\d{17,20}$/.test(String(id || '').trim());
const isTest = (id, data) => !isDiscordId(id) || (data?.user_id && !isDiscordId(data.user_id));
function normalize(row) { if (!row?.data) return null; const data = clone(row.data); const id = data.user_id || data.userId || row.id; data.user_id ||= id; data.userId ||= id; data.preferences = normalizeUserPreferences(data.preferences, data.has_premium); return data; }
const withTimeout = (promise, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 8000))]);
function createDataManager({ allowSyntheticUserIds = false } = {}) {
 const users = () => getMongoDatabase().collection('users'), sessions = () => getMongoDatabase().collection('interaction_sessions');
 const locks = new Map(), cache = new Map(), als = new AsyncLocalStorage();
 const getCached = id => { const x=cache.get(id); if (!x || x.expires < Date.now()) { cache.delete(id); return undefined; } return clone(x.data); };
 const setCached = (id,data) => cache.set(id,{data:clone(data),expires:Date.now()+1000});
 const enqueue = (id, op) => { const prior=locks.get(id)||Promise.resolve(); const next=prior.catch(()=>{}).then(op); locks.set(id,next); next.finally(()=>{if(locks.get(id)===next)locks.delete(id);}); return next; };
 const run = (id, op) => als.getStore()===id ? op() : enqueue(id, () => als.run(id,op));
 async function row(collection,id) { return withTimeout(collection.findOne({_id:id}), `Database read timed out for ${id}.`); }
 async function mutate(collection,id,mutator,isUser=true) { for(let i=0;i<25;i++){ const r=await row(collection,id), current=isUser?normalize(r):clone(r?.data??null), next=await mutator(clone(current)); if(next==null)return {committed:false,user:current}; if(typeof next!=='object'||Array.isArray(next))throw new TypeError('Data transaction mutator must return an object or undefined.'); if(!r){ try { await collection.insertOne({_id:id,id,data:next,version:1,updated_at:new Date()}); if(isUser)setCached(id,next); return {committed:true,user:next}; } catch(e){if(e.code===11000)continue;throw e;} } const result=await collection.updateOne({_id:id,version:Number(r.version)||0},{$set:{data:next,updated_at:new Date()},$inc:{version:1}}); if(result.modifiedCount){if(isUser)setCached(id,next);return {committed:true,user:next};} } throw new Error(`Transaction for ${id} was not committed after 25 retries.`); }
 async function initializeUser(id,username){if(!id||( !allowSyntheticUserIds&&isTest(id)))throw new TypeError('initializeUser requires a valid Discord user ID.');return run(id,async()=>{let r=await row(users(),id);if(r)return normalize(r);const user={user_id:id,userId:id,username:username||'',created_at:new Date().toISOString(),continents:normalizeOwnedContinents([continentData[0]?.ContinentName||'Start Continent']),current_continent:'Start Continent',current_mine:'Coal Mine',cash:10,ice_cash:0,fire_cash:0,dawn_cash:0,idle_cash:0,idle_ice_cash:0,idle_fire_cash:0,idle_dawn_cash:0,mines:[{prestige_count:0,mine_number:1,mine_name:'Coal Mine',continent_name:'Start Continent',factor:1,mineshafts:[],elevator:[],warehouse:[],managers:{shaft:[],elevator:[],warehouse:[]},barriers:mineRegions.map((x,i)=>({...x,unlocked:i===0}))}],super_cash:0,streak:0,last_daily:0,last_idle:0,last_idle_accrued_at:0,last_monthly:0,has_premium:false,active_boosts:[],inventory:{},preferences:normalizeUserPreferences(null,false)};try{await users().insertOne({_id:id,id,data:user,version:1,updated_at:new Date()});setCached(id,user);return user;}catch(e){if(e.code!==11000)throw e; r=await row(users(),id);return normalize(r);}});}
 async function getUser(id){if(!id||(!allowSyntheticUserIds&&isTest(id)))return null;try{let u=getCached(id);if(u!==undefined)return u;const r=await row(users(),id);u=normalize(r);if(u)setCached(id,u);return u;}catch(e){console.error(`Error fetching user ${id}:`,e.message);return null;}}
 async function updateUser(id,updates){if(!updates||typeof updates!=='object')throw new TypeError('updateUser requires an update object.');return run(id,async()=>{const current=await getUser(id);const patch=updates[snapshot]||updates;const result=await mutate(users(),id,c=>({...c,...clone(patch)}));return normalize({_id:id,id,data:result.user});});}
 async function updateUserTransaction(id,mutator){return run(id,async()=>{const r=await mutate(users(),id,mutator);return {committed:r.committed,aborted:!r.committed,user:r.user?normalize({id,data:r.user}):r.user};});}
 async function commitUserSnapshot(id,candidate){return updateUserTransaction(id,()=>clone(candidate));}
 async function removeUser(id,data=null){if(!id||!isTest(id,data))return false;await users().deleteOne({_id:id});cache.delete(id);return true;}
 async function removeTestUsers(){const all=await users().find({}).toArray();let n=0;for(const r of all)if(await removeUser(r.id,r.data))n++;return n;}
 async function getAllUsers(){const all=await users().find({}).toArray(),out={};for(const r of all)if(allowSyntheticUserIds||!isTest(r.id,r.data))out[r.id]=normalize(r)||{};return out;}
 async function createInteractionSession(id,data){await sessions().updateOne({_id:id},{$set:{id,data:clone(data),updated_at:new Date()}},{upsert:true});return data;}
 async function closeInteractionSession(id,reason='collector-ended'){const r=await row(sessions(),id);if(!r)return false;await sessions().updateOne({_id:id},{$set:{data:{...(r.data||{}),status:'closed',closeReason:reason,closedAt:Date.now()},updated_at:new Date()}});return true;}
 async function getAllInteractionSessions(){const all=await sessions().find({}).toArray();return Object.fromEntries(all.map(r=>[r.id,r.data||{}]));}
 async function removeInteractionSession(id){if(!id)return false;await sessions().deleteOne({_id:id});return true;}
 async function withUserLock(id,op){return run(id,op);}
 async function mutateUser(id,mutator){const u=await getUser(id);if(!u)return null;const result=await mutator(u);return result===false?u:updateUserTransaction(id,()=>result&&typeof result==='object'?result:u);}
 return {initializeUser,getUser,updateUser,updateUserTransaction,commitUserSnapshot,mutateUser,withUserLock,getAllUsers,removeUser,removeTestUsers,createInteractionSession,closeInteractionSession,getAllInteractionSessions,removeInteractionSession};
}
const dataManager=createDataManager(); export {createDataManager}; export const {initializeUser,getUser,updateUser,updateUserTransaction,commitUserSnapshot,mutateUser,withUserLock,getAllUsers,removeUser,removeTestUsers,createInteractionSession,closeInteractionSession,getAllInteractionSessions,removeInteractionSession}=dataManager; export default dataManager;
