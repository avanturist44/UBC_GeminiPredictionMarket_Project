// No post text, cookies, wallet credentials or orders enter this service worker.
importScripts('constants.js','mock.js');
const cards=new Map(),pending=new Map(),namespace=`${TM.API_BASE}:${TM.USE_MOCK}`;
const key=name=>`${namespace}:${name}`;
async function getJSON(path){const response=await fetch(TM.API_BASE+path,{credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();}
async function loadMarkets(){
  const stored=(await chrome.storage.session.get(key('markets')))[key('markets')];
  if(stored&&Date.now()-stored.at<TM.MARKETS_REFRESH_MS)return stored.data;
  try{const data=TM.USE_MOCK?MOCK.markets:(await getJSON('/api/ext/markets')).markets;if(!Array.isArray(data))throw new Error('Invalid market list');
    const checked=data.filter(m=>typeof m?.symbol==='string'&&/^[A-Za-z0-9._-]{1,100}$/.test(m.symbol)&&Array.isArray(m.keywords)).slice(0,100)
      .map(m=>({...m,keywords:m.keywords.filter(Array.isArray).slice(0,20).filter(group=>group.length>0&&group.length<=8&&group.every(term=>typeof term==='string'&&term.trim().length>0&&term.length<=80))}));
    await chrome.storage.session.set({[key('markets')]:{at:Date.now(),data:checked}});return checked;
  }catch{return stored?.data??null;}
}
async function loadCard(symbol){
  const hit=cards.get(symbol);if(hit&&Date.now()-hit.at<TM.CARD_TTL_MS)return hit.card;
  if(pending.has(symbol))return pending.get(symbol);
  const work=(async()=>{try{const card=TM.USE_MOCK?MOCK.cards[symbol]??null:await getJSON(`/api/ext/card?symbol=${encodeURIComponent(symbol)}`);
    if(card&&(card.symbol!==symbol||typeof card.title!=='string'))throw new Error('Invalid card');cards.set(symbol,{at:Date.now(),card});if(cards.size>100)cards.delete(cards.keys().next().value);return card;
  }catch{return hit?.card?{...hit.card,stale:true}:null;}finally{pending.delete(symbol);}})();pending.set(symbol,work);return work;
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||!/^https:\/\/(?:x|twitter)\.com\//.test(sender.url??''))return false;
  let work;
  if(message?.type==='markets')work=loadMarkets();
  else if(message?.type==='card'&&/^[A-Za-z0-9._-]{1,100}$/.test(message.symbol??''))work=loadCard(message.symbol);
  else if(message?.type==='dismissed')work=chrome.storage.session.get(key('dismissed')).then(data=>data[key('dismissed')]??[]);
  else if(message?.type==='dismiss'&&/^[A-Za-z0-9._-]{1,100}$/.test(message.symbol??''))work=(async()=>{const data=await chrome.storage.session.get(key('dismissed'));const values=new Set(data[key('dismissed')]??[]);values.add(message.symbol);await chrome.storage.session.set({[key('dismissed')]:[...values].slice(-100)});return true;})();
  else return false;
  Promise.resolve(work).then(respond).catch(()=>respond(null));return true;
});
