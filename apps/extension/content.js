// Match only the post's own text locally. Send matched symbols, never post text.
(() => {
  const dismissed=new Set(),states=new WeakMap();let markets=[],marketsAt=0,marketRequest,scanTimer,slots=0;
  function send(message){return new Promise(resolve=>{try{chrome.runtime.sendMessage(message,result=>resolve(chrome.runtime.lastError?null:result));}catch{resolve(null);}});}
  function schedule(delay=150){if(!scanTimer)scanTimer=setTimeout(()=>{scanTimer=null;scan();},delay);}
  async function ensureMarkets(){
    if(Date.now()-marketsAt<TM.MARKETS_REFRESH_MS)return markets;
    if(!marketRequest)marketRequest=send({type:'markets'}).then(result=>{if(Array.isArray(result)){markets=result;marketsAt=Date.now();}return markets;}).finally(()=>{marketRequest=null;});
    return marketRequest;
  }
  function onClose(symbol){dismissed.add(symbol);void send({type:'dismiss',symbol});for(const node of document.querySelectorAll('[data-tm-card]'))if(node.dataset.tmCard===symbol)node.remove();schedule();}
  function ownText(post){return [...post.querySelectorAll(TM.SELECTORS.text)].find(node=>!node.closest('[data-testid="quoteTweet"]'));}
  async function process(post){
    const anchor=ownText(post);if(!anchor)return;
    const fingerprint=anchor.textContent??'';let state=states.get(post);
    if(state?.fingerprint!==fingerprint){state?.host?.remove();state={fingerprint,host:null,pending:false,at:0};states.set(post,state);}
    if(state.pending||state.host?.isConnected)return;
    if(Date.now()-state.at<2000)return;
    state.pending=true;state.at=Date.now();let reserved=false;
    try{
      const list=await ensureMarkets();if(!list.length)return;
      const match=TMMatch.bestMatch(fingerprint,list.filter(m=>!dismissed.has(m.symbol)));if(!match)return;
      // After the shared market lookup, reserve before fetching a card. Unrelated posts take no slot.
      if(document.querySelectorAll('[data-tm-card]').length+slots>=TM.MAX_CARDS_ON_SCREEN)return;
      slots++;reserved=true;
      const card=await send({type:'card',symbol:match.symbol});
      if(!card||(!card.top&&!(card.summary?.thesisCount>=TM.MIN_THESES_FOR_SUMMARY))){state.at=Date.now()+TM.CARD_TTL_MS;return;}
      if(dismissed.has(match.symbol)||!post.isConnected||states.get(post)!==state||ownText(post)?.textContent!==fingerprint)return;
      const host=TMCard.mount(card,{onClose});anchor.insertAdjacentElement('afterend',host);state.host=host;
    }finally{if(reserved)slots--;state.pending=false;}
  }
  function scan(){
    const posts=[...document.querySelectorAll(TM.SELECTORS.post)];
    const near=post=>{const box=post.getBoundingClientRect();return box.bottom>=-800&&box.top<=innerHeight+800;};
    for(const post of posts){const state=states.get(post);if(!near(post)&&state?.host){state.host.remove();state.host=null;state.at=0;}}
    for(const post of posts){if(!near(post))continue;const state=states.get(post);if(state?.host?.isConnected)TMCard.updateTheme(state.host);void process(post);}
  }
  const observer=new MutationObserver(()=>schedule());observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  new MutationObserver(()=>schedule()).observe(document.body,{attributes:true,attributeFilter:['class','style']});
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>schedule());
  addEventListener('scroll',()=>schedule(),{passive:true});
  // A short retry also handles delayed text, API recovery and cards removed by X's own rerenders.
  const retry=setInterval(()=>schedule(),3000);
  addEventListener('pagehide',()=>{observer.disconnect();clearInterval(retry);},{once:true});
  send({type:'dismissed'}).then(values=>{if(Array.isArray(values))values.forEach(value=>dismissed.add(value));schedule(0);});
})();
