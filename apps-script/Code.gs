/** Designated Drinks Wholesale backend v7.1 — province-aware GST/HST. */
const CONFIG = Object.freeze({
  SPREADSHEET_ID:"17bcjrwi7Ah8_SXaPc9VrCIi2fdYnnNofmUoGy4LKBQ8",
  PRODUCTS_SHEET_NAME:"Sheet1", ORDERS_SHEET_NAME:"Orders", ORDER_ITEMS_SHEET_NAME:"Order Items",
  SETTINGS_SHEET_NAME:"Settings", LOGS_SHEET_NAME:"Logs",
  SALES_EMAIL:"sales@designateddrinks.ca", BACKUP_EMAIL:"designateddrinksonline@gmail.com",
  SUPPORT_EMAIL:"sales@designateddrinks.ca", MAX_ITEMS:200, MAX_QUANTITY_PER_ITEM:999,
  STATUS_TTL_SECONDS:21600, STATUS_RETENTION_MS:86400000, PRODUCT_CACHE_SECONDS:60, VERSION:"7.1"
});

const TAX_RULES = Object.freeze({
  AB:{province:"Alberta",label:"GST",rate:.05}, BC:{province:"British Columbia",label:"GST",rate:.05},
  MB:{province:"Manitoba",label:"GST",rate:.05}, NB:{province:"New Brunswick",label:"HST",rate:.15},
  NL:{province:"Newfoundland and Labrador",label:"HST",rate:.15}, NS:{province:"Nova Scotia",label:"HST",rate:.14},
  NT:{province:"Northwest Territories",label:"GST",rate:.05}, NU:{province:"Nunavut",label:"GST",rate:.05},
  ON:{province:"Ontario",label:"HST",rate:.13}, PE:{province:"Prince Edward Island",label:"HST",rate:.15},
  QC:{province:"Quebec",label:"GST",rate:.05}, SK:{province:"Saskatchewan",label:"GST",rate:.05},
  YT:{province:"Yukon",label:"GST",rate:.05}
});

const ORDER_HEADERS=Object.freeze(["Order ID","Timestamp","Company","Contact","Email","Phone","Fulfilment","Delivery Address","PO Number","Notes","Total Cases","Subtotal","Sales Tax","Estimated Total","Order Status","Notification Status","Notification Warnings","Submission ID","Province","Tax Label","Tax Rate"]);
const ITEM_HEADERS=Object.freeze(["Order ID","SKU","Product","Brand","Quantity","Case Format","Case Price","Line Total"]);
const LOG_HEADERS=Object.freeze(["Timestamp","Submission ID","Order ID","Action","Result","Error"]);
const SETTINGS_HEADERS=Object.freeze(["Key","Value","Description"]);

function doGet(e){
  const p=e&&e.parameter?e.parameter:{}, action=cleanText_(p.action,40).toLowerCase(), cb=cleanCallback_(p.callback); let out;
  try{
    if(action==="products") out={status:"success",version:CONFIG.VERSION,products:getPublicProducts_()};
    else if(action==="status") out=p.submissionId?getStatus_(cleanText_(p.submissionId,120)):{status:"error",message:"Missing submission ID."};
    else if(action==="tax") { const code=normalizeProvince_(p.province)||"ON"; out=Object.assign({status:"success",code:code},TAX_RULES[code]); }
    else out={status:"ok",version:CONFIG.VERSION,message:"Wholesale order endpoint is live."};
  }catch(err){console.error(err);out={status:"error",message:"The wholesale service could not complete the request."};}
  return outputResponse_(out,cb);
}

function doPost(e){
  let lock=null, submissionId="", orderId="";
  try{
    if(!e||!e.parameter) throw new Error("No order data was received.");
    const p=e.parameter; submissionId=cleanText_(p.submissionId,120); if(!submissionId) throw new Error("The order is missing its submission ID.");
    cleanupOldStatuses_();
    const prior=getStatus_(submissionId); if(prior&&prior.status==="success") return textResponse_("duplicate");
    setStatus_(submissionId,{status:"processing",stage:"validating",message:"The order is being validated."});
    if(cleanText_(p.website,200)){setStatus_(submissionId,{status:"success",stage:"complete"});return textResponse_("success");}

    const customer=parseCustomer_(p), requested=parseItems_(p);
    if(!requested.length) throw new Error("Please select at least one product.");
    if(requested.length>CONFIG.MAX_ITEMS) throw new Error("The order contains too many line items.");

    const ss=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID), sheets=ensureSystemSheets_(ss), settings=getSettings_(sheets.settings);
    if(String(settings.ordering_enabled||"true").toLowerCase()==="false") throw new Error("Wholesale ordering is temporarily unavailable. Please contact "+settings.support_email+".");

    lock=LockService.getScriptLock(); lock.waitLock(30000);
    const existing=findOrderBySubmissionId_(sheets.orders,submissionId);
    if(existing&&existing.status==="RECEIVED"){const payload=statusPayloadFromOrder_(existing);setStatus_(submissionId,payload);return textResponse_("duplicate");}

    const catalog=getProductCatalog_(ss), items=priceItemsFromCatalog_(requested,catalog), totals=calculateTotals_(items,taxRuleForCustomer_(customer)), now=new Date();
    if(existing){orderId=existing.orderId;clearOrderItems_(sheets.orderItems,orderId);writeOrderRow_(sheets.orders,existing.row,orderId,now,customer,totals,"WRITING","PENDING","",submissionId);}
    else{orderId=createOrderId_(sheets.orders,now);writeOrderRow_(sheets.orders,Math.max(sheets.orders.getLastRow()+1,2),orderId,now,customer,totals,"WRITING","PENDING","",submissionId);}
    writeOrderItems_(sheets.orderItems,orderId,items); SpreadsheetApp.flush(); verifyPersistedOrder_(sheets.orders,sheets.orderItems,orderId,submissionId,items.length);

    const saved=findOrderBySubmissionId_(sheets.orders,submissionId); if(!saved) throw new Error("The saved order could not be verified.");
    sheets.orders.getRange(saved.row,15).setValue("RECEIVED"); SpreadsheetApp.flush();
    setStatus_(submissionId,statusPayload_("processing","saved",orderId,totals,[],"sending"));
    logEvent_(sheets.logs,submissionId,orderId,"ORDER_SAVED","SUCCESS","");
    lock.releaseLock(); lock=null;

    const notice=sendNotifications_(now,orderId,customer,items,totals,settings);
    sheets.orders.getRange(saved.row,16,1,2).setValues([[notice.status,notice.warnings.join(", ")]]); SpreadsheetApp.flush();
    logEvent_(sheets.logs,submissionId,orderId,"NOTIFICATIONS",notice.status,notice.warnings.join(", "));
    setStatus_(submissionId,statusPayload_("success","complete",orderId,totals,notice.warnings,notice.status.toLowerCase()));
    return textResponse_("success");
  }catch(err){
    const message=err&&err.message?String(err.message):"The order could not be processed."; console.error("doPost error:",err);
    try{const ss=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID), logs=ss.getSheetByName(CONFIG.LOGS_SHEET_NAME);if(logs)logEvent_(logs,submissionId,orderId,"ORDER_SUBMISSION","ERROR",message);const orders=ss.getSheetByName(CONFIG.ORDERS_SHEET_NAME);if(orders&&submissionId){const x=findOrderBySubmissionId_(orders,submissionId);if(x&&x.status!=="RECEIVED")orders.getRange(x.row,15).setValue("ERROR");}}catch(logErr){console.error(logErr);}
    if(submissionId)setStatus_(submissionId,{status:"error",message:message}); return textResponse_("error");
  }finally{if(lock)try{lock.releaseLock();}catch(_){}}
}

function setupSystem(){
  const ss=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID),s=ensureSystemSheets_(ss);ensureProductMetadata_(s.products);seedSettings_(s.settings);formatSystemSheets_(s);CacheService.getScriptCache().remove(productCacheKey_());Logger.log("Wholesale v"+CONFIG.VERSION+" ready.");
}
function ensureSystemSheets_(ss){const p=ss.getSheetByName(CONFIG.PRODUCTS_SHEET_NAME);if(!p)throw new Error('The product sheet "'+CONFIG.PRODUCTS_SHEET_NAME+'" was not found.');return{products:p,orders:getOrCreateSheet_(ss,CONFIG.ORDERS_SHEET_NAME,ORDER_HEADERS),orderItems:getOrCreateSheet_(ss,CONFIG.ORDER_ITEMS_SHEET_NAME,ITEM_HEADERS),settings:getOrCreateSheet_(ss,CONFIG.SETTINGS_SHEET_NAME,SETTINGS_HEADERS),logs:getOrCreateSheet_(ss,CONFIG.LOGS_SHEET_NAME,LOG_HEADERS)};}
function getOrCreateSheet_(ss,name,headers){let s=ss.getSheetByName(name);if(!s)s=ss.insertSheet(name);ensureHeaders_(s,headers);return s;}
function ensureHeaders_(s,headers){if(s.getMaxColumns()<headers.length)s.insertColumnsAfter(s.getMaxColumns(),headers.length-s.getMaxColumns());const r=s.getRange(1,1,1,headers.length),v=r.getValues()[0];headers.forEach((h,i)=>{if(!String(v[i]||"").trim()||i>=18)s.getRange(1,i+1).setValue(h);});s.setFrozenRows(1);}
function ensureProductMetadata_(s){const h=["SKU","Brand","Category","Style","Case Format","Sort Order"];s.getRange(1,8,1,h.length).setValues([h]);const last=s.getLastRow();if(last<2)return;const rows=s.getRange(2,1,last-1,13).getValues();s.getRange(2,8,rows.length,6).setValues(rows.map((r,i)=>{const title=cleanText_(r[0],300),pack=cleanText_(r[1],100),parts=splitProductTitle_(title),cat=cleanText_(r[9],80)||inferCategory_(title);return[cleanText_(r[7],80)||"DDW-"+String(i+2).padStart(4,"0"),cleanText_(r[8],160)||parts.brand,cat,cleanText_(r[10],100)||inferStyle_(title,cat),cleanText_(r[11],100)||(pack?"24 × "+pack:"Case"),Number(r[12])||i+2];}));}
function seedSettings_(s){if(s.getLastRow()>1)return;s.getRange(2,1,5,3).setValues([["internal_notification_email",CONFIG.SALES_EMAIL,"Primary wholesale notification"],["backup_notification_email",CONFIG.BACKUP_EMAIL,"Backup notification"],["support_email",CONFIG.SUPPORT_EMAIL,"Customer support email"],["ordering_enabled","true","Set false to pause orders"],["shipping_message","Availability and freight are confirmed before invoicing.","Confirmation note"]]);}
function getSettings_(s){const x={internal_notification_email:CONFIG.SALES_EMAIL,backup_notification_email:CONFIG.BACKUP_EMAIL,support_email:CONFIG.SUPPORT_EMAIL,ordering_enabled:"true",shipping_message:"Availability and freight are confirmed before invoicing."};if(s.getLastRow()>=2)s.getRange(2,1,s.getLastRow()-1,2).getValues().forEach(r=>{const k=cleanText_(r[0],100);if(k)x[k]=r[1];});return x;}
function formatSystemSheets_(s){[s.orders,s.orderItems,s.settings,s.logs].forEach(sh=>{const n=sh.getLastColumn();sh.getRange(1,1,1,n).setBackground("#071c33").setFontColor("#ffffff").setFontWeight("bold");});s.orders.getRange("L:N").setNumberFormat("$0.00");s.orders.getRange("U:U").setNumberFormat("0.00%");s.orderItems.getRange("G:H").setNumberFormat("$0.00");}

function parseCustomer_(p){
  const fulfilment=cleanText_(p.fulfilment||p.deliveryMethod,30)||"Delivery", address=cleanText_(p.deliveryAddress,500);
  let province=normalizeProvince_(p.province||p.deliveryProvince||p.provinceCode);
  if(fulfilment==="Pickup")province="ON"; else if(!province)province=provinceFromAddress_(address);
  const c={contact:cleanText_(p.fullName||p.contactName,120),company:cleanText_(p.companyName,160),email:cleanText_(p.email,200).toLowerCase(),phone:cleanText_(p.phone,40),fulfilment:fulfilment,deliveryAddress:address,province:province,poNumber:cleanText_(p.poNumber,80),notes:cleanText_(p.notes,500)};
  if(!c.company)throw new Error("Company name is required.");if(!c.contact)throw new Error("Contact name is required.");if(!isValidEmail_(c.email))throw new Error("A valid email address is required.");if(c.phone.replace(/\D/g,"").length<7)throw new Error("A valid phone number is required.");if(!["Delivery","Pickup"].includes(c.fulfilment))throw new Error("Choose delivery or pickup.");if(c.fulfilment==="Delivery"&&!c.deliveryAddress)throw new Error("A delivery address is required.");if(!TAX_RULES[c.province])throw new Error("Select a valid Canadian province or territory.");return c;
}
function normalizeProvince_(v){let x=cleanText_(v,80).toUpperCase();if(TAX_RULES[x])return x;try{x=x.normalize("NFD").replace(/[\u0300-\u036f]/g,"");}catch(_){}x=x.replace(/[^A-Z]/g,"");const a={ALBERTA:"AB",BRITISHCOLUMBIA:"BC",MANITOBA:"MB",NEWBRUNSWICK:"NB",NEWFOUNDLANDANDLABRADOR:"NL",NEWFOUNDLANDLABRADOR:"NL",NOVASCOTIA:"NS",NORTHWESTTERRITORIES:"NT",NUNAVUT:"NU",ONTARIO:"ON",PRINCEEDWARDISLAND:"PE",QUEBEC:"QC",SASKATCHEWAN:"SK",YUKON:"YT"};return a[x]||"";}
function provinceFromAddress_(a){const t=String(a||"").toUpperCase(),codes=Object.keys(TAX_RULES);for(let i=0;i<codes.length;i++){const c=codes[i];if(new RegExp("(?:^|[,\\s])"+c+"(?:\\s+[A-Z]\\d[A-Z]|[,\\s]|$)").test(t))return c;}return"";}
function taxRuleForCustomer_(c){const code=c.fulfilment==="Pickup"?"ON":c.province, r=TAX_RULES[code];if(!r)throw new Error("Sales tax could not be determined for the delivery province.");return{code:code,province:r.province,label:r.label,rate:r.rate};}

function parseItems_(p){if(p.items){try{const a=JSON.parse(p.items);if(Array.isArray(a))return a.map(i=>({sku:cleanText_(i.sku,80),catalogTitle:cleanText_(i.catalogTitle,300),cases:cleanQuantity_(i.cases)})).filter(validRequestedItem_);}catch(_){throw new Error("The order items were not formatted correctly.");}}const m={};Object.keys(p).forEach(k=>{const x=k.match(/^item_(\d+)_(sku|catalogTitle|cases)$/);if(!x)return;const i=+x[1],f=x[2];if(!m[i])m[i]={sku:"",catalogTitle:"",cases:0};m[i][f]=f==="cases"?cleanQuantity_(p[k]):cleanText_(p[k],f==="sku"?80:300);});return Object.keys(m).map(Number).sort((a,b)=>a-b).map(i=>m[i]).filter(validRequestedItem_);}
function validRequestedItem_(i){return Boolean((i.sku||i.catalogTitle)&&i.cases>0);}

function getProductCatalog_(ss){const s=ss.getSheetByName(CONFIG.PRODUCTS_SHEET_NAME),last=s.getLastRow();if(last<2)throw new Error("The product catalogue is empty.");const rows=s.getRange(2,1,last-1,Math.max(s.getLastColumn(),13)).getValues(),bySku={},byTitle={},publicProducts=[];rows.forEach((r,i)=>{const title=cleanText_(r[0],300),status=cleanText_(r[6],30).toLowerCase();if(!title||!["yes","active","true"].includes(status))return;const price=roundMoney_(Number(r[5]));if(!Number.isFinite(price)||price<=0)return;const parts=splitProductTitle_(title),cat=cleanText_(r[9],80)||inferCategory_(title),p={sku:cleanText_(r[7],80)||"DDW-"+String(i+2).padStart(4,"0"),catalogTitle:title,brand:cleanText_(r[8],160)||parts.brand,name:parts.name,category:cat,style:cleanText_(r[10],100)||inferStyle_(title,cat),packageSize:cleanText_(r[1],100),caseFormat:cleanText_(r[11],100)||"24 × "+cleanText_(r[1],100),casePrice:price,imageUrl:cleanText_(r[4],1000),active:true,sortOrder:Number(r[12])||i+2};bySku[p.sku]=p;byTitle[p.catalogTitle]=p;publicProducts.push(p);});return{bySku:bySku,byTitle:byTitle,publicProducts:publicProducts};}
function productCacheKey_(){return"ddw-products-v"+CONFIG.VERSION;}
function getPublicProducts_(){const cache=CacheService.getScriptCache(),key=productCacheKey_(),hit=cache.get(key);if(hit)return JSON.parse(hit);const p=getProductCatalog_(SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)).publicProducts.sort((a,b)=>a.sortOrder-b.sortOrder||a.brand.localeCompare(b.brand)||a.name.localeCompare(b.name));cache.put(key,JSON.stringify(p),CONFIG.PRODUCT_CACHE_SECONDS);return p;}
function priceItemsFromCatalog_(requested,catalog){const seen={};return requested.map(i=>{const p=(i.sku&&catalog.bySku[i.sku])||(i.catalogTitle&&catalog.byTitle[i.catalogTitle]);if(!p)throw new Error("A selected product is unavailable or its price could not be confirmed.");if(seen[p.sku])throw new Error("The order contains a duplicated product.");seen[p.sku]=1;return{sku:p.sku,catalogTitle:p.catalogTitle,displayTitle:p.brand+" – "+p.name,brand:p.brand,name:p.name,caseFormat:p.caseFormat,cases:i.cases,unitPrice:p.casePrice,lineTotal:roundMoney_(i.cases*p.casePrice)};});}
function calculateTotals_(items,taxRule){const subtotal=roundMoney_(items.reduce((s,i)=>s+i.lineTotal,0)),totalCases=items.reduce((s,i)=>s+i.cases,0),tax=roundMoney_(subtotal*taxRule.rate);return{totalCases:totalCases,subtotal:subtotal,tax:tax,hst:tax,total:roundMoney_(subtotal+tax),province:taxRule.code,provinceName:taxRule.province,taxLabel:taxRule.label,taxRate:taxRule.rate};}

function writeOrderRow_(s,row,id,now,c,t,status,notice,warnings,submissionId){const vals=[id,now,safeSheetCell_(c.company),safeSheetCell_(c.contact),safeSheetCell_(c.email),safeSheetCell_(c.phone),c.fulfilment,safeSheetCell_(c.deliveryAddress),safeSheetCell_(c.poNumber),safeSheetCell_(c.notes),t.totalCases,t.subtotal,t.tax,t.total,status,notice,warnings,submissionId,t.province,t.taxLabel,t.taxRate];s.getRange(row,1,1,vals.length).setValues([vals]);s.getRange(row,12,1,3).setNumberFormat("$0.00");s.getRange(row,21).setNumberFormat("0.00%");}
function writeOrderItems_(s,id,items){const start=Math.max(s.getLastRow()+1,2),v=items.map(i=>[id,i.sku,safeSheetCell_(i.displayTitle),safeSheetCell_(i.brand),i.cases,safeSheetCell_(i.caseFormat),i.unitPrice,i.lineTotal]);s.getRange(start,1,v.length,ITEM_HEADERS.length).setValues(v);s.getRange(start,7,v.length,2).setNumberFormat("$0.00");}
function clearOrderItems_(s,id){if(s.getLastRow()<2)return;const a=s.getRange(2,1,s.getLastRow()-1,1).getValues();for(let i=a.length-1;i>=0;i--)if(String(a[i][0])===id)s.deleteRow(i+2);}
function verifyPersistedOrder_(orders,items,id,submissionId,n){const o=findOrderBySubmissionId_(orders,submissionId);if(!o||o.orderId!==id)throw new Error("The order row was not saved correctly.");let count=0;if(items.getLastRow()>=2)items.getRange(2,1,items.getLastRow()-1,1).getValues().forEach(r=>{if(String(r[0])===id)count++;});if(count!==n)throw new Error("Not every order item was saved correctly.");}
function findOrderBySubmissionId_(s,id){if(!id||s.getLastRow()<2)return null;const cols=Math.max(ORDER_HEADERS.length,18),v=s.getRange(2,1,s.getLastRow()-1,cols).getValues();for(let i=v.length-1;i>=0;i--){const r=v[i];if(String(r[17])===id)return{row:i+2,orderId:String(r[0]),totalCases:Number(r[10])||0,subtotal:Number(r[11])||0,tax:Number(r[12])||0,hst:Number(r[12])||0,total:Number(r[13])||0,status:String(r[14]),notificationStatus:String(r[15]),warnings:String(r[16]||""),province:String(r[18]||""),taxLabel:String(r[19]||""),taxRate:Number(r[20])||0};}return null;}
function createOrderId_(s,d){const date=Utilities.formatDate(d,Session.getScriptTimeZone(),"yyyyMMdd"),prefix="DDW-"+date+"-";let high=0;if(s.getLastRow()>=2)s.getRange(2,1,s.getLastRow()-1,1).getValues().forEach(r=>{const v=String(r[0]||"");if(v.indexOf(prefix)===0)high=Math.max(high,Number(v.slice(prefix.length))||0);});return prefix+String(high+1).padStart(3,"0");}

function statusPayload_(status,stage,id,t,warnings,emailStatus){return{status:status,stage:stage,orderId:id,totalCases:t.totalCases,subtotal:t.subtotal,tax:t.tax,hst:t.tax,total:t.total,province:t.province,provinceName:t.provinceName,taxLabel:t.taxLabel,taxRate:t.taxRate,warnings:warnings||[],emailStatus:emailStatus||""};}
function statusPayloadFromOrder_(o){return{status:"success",stage:"complete",orderId:o.orderId,totalCases:o.totalCases,subtotal:o.subtotal,tax:o.tax,hst:o.tax,total:o.total,province:o.province,taxLabel:o.taxLabel,taxRate:o.taxRate,warnings:o.warnings?o.warnings.split(", ").filter(Boolean):[],emailStatus:(o.notificationStatus||"").toLowerCase()};}
function setStatus_(id,payload){const x=Object.assign({},payload,{updatedAt:Date.now()}),key="wholesale-status:"+id,val=JSON.stringify(x);PropertiesService.getScriptProperties().setProperty(key,val);CacheService.getScriptCache().put(key,val,CONFIG.STATUS_TTL_SECONDS);}
function getStatus_(id){const key="wholesale-status:"+id,cache=CacheService.getScriptCache(),raw=cache.get(key)||PropertiesService.getScriptProperties().getProperty(key);if(raw)try{return JSON.parse(raw);}catch(_){}try{const s=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.ORDERS_SHEET_NAME);if(s){const o=findOrderBySubmissionId_(s,id);if(o&&o.status==="RECEIVED")return statusPayloadFromOrder_(o);if(o)return{status:"processing",stage:"saved",orderId:o.orderId};}}catch(err){console.error(err);}return{status:"pending",message:"The order has not been confirmed yet."};}
function cleanupOldStatuses_(){const p=PropertiesService.getScriptProperties(),all=p.getProperties(),cut=Date.now()-CONFIG.STATUS_RETENTION_MS,remove=[];Object.keys(all).forEach(k=>{if(k.indexOf("wholesale-status:")!==0)return;try{const x=JSON.parse(all[k]);if(!x.updatedAt||Number(x.updatedAt)<cut)remove.push(k);}catch(_){remove.push(k);}});if(remove.length)p.deleteProperties(remove);}

function taxSummaryLabel_(t){return t.taxLabel+" ("+Math.round(t.taxRate*100)+"%)"+(t.provinceName?" – "+t.provinceName:"");}
function sendNotifications_(now,id,c,items,t,settings){const warnings=[];let internal=false,subject="NEW WHOLESALE ORDER — "+id+" — "+safeSubject_(c.company),body=buildSalesEmailText_(now,id,c,items,t);try{MailApp.sendEmail({to:settings.internal_notification_email,replyTo:c.email,subject:subject,body:body,name:"Designated Drinks Wholesale"});internal=true;}catch(_){warnings.push("internal-primary-email");}if(settings.backup_notification_email&&settings.backup_notification_email!==settings.internal_notification_email)try{MailApp.sendEmail({to:settings.backup_notification_email,replyTo:c.email,subject:"BACKUP — "+subject,body:body,name:"Designated Drinks Wholesale"});internal=true;}catch(_){warnings.push("internal-backup-email");}if(!internal)warnings.push("internal-email");try{MailApp.sendEmail({to:c.email,replyTo:settings.support_email,subject:"Wholesale order received — "+id,body:buildCustomerEmailText_(id,c,items,t,settings),name:"Designated Drinks"});}catch(_){warnings.push("customer-email");}return{status:warnings.length?(internal?"PARTIAL":"FAILED"):"SENT",warnings:warnings};}
function buildSalesEmailText_(now,id,c,items,t){return["NEW WHOLESALE ORDER","","Order: "+id,"Received: "+now,"Company: "+c.company,"Contact: "+c.contact,"Email: "+c.email,"Phone: "+c.phone,"Fulfilment: "+c.fulfilment,c.deliveryAddress?"Address: "+c.deliveryAddress:"","Tax province: "+t.provinceName+(t.province?" ("+t.province+")":""),c.poNumber?"PO: "+c.poNumber:"",c.notes?"Notes: "+c.notes:"","",buildSummary_(items),"","Total cases: "+t.totalCases,"Subtotal: "+formatMoney_(t.subtotal),taxSummaryLabel_(t)+": "+formatMoney_(t.tax),"Estimated total: "+formatMoney_(t.total)].filter(Boolean).join("\n");}
function buildCustomerEmailText_(id,c,items,t,settings){return["DESIGNATED DRINKS","Wholesale order received","","Hi "+c.contact+",","","We recorded the wholesale order for "+c.company+".","Order: "+id,"",buildSummary_(items),"","Total cases: "+t.totalCases,"Subtotal: "+formatMoney_(t.subtotal),taxSummaryLabel_(t)+": "+formatMoney_(t.tax),"Estimated total: "+formatMoney_(t.total),"",settings.shipping_message,"This confirmation records your order request and is not a final invoice.","","Questions? "+settings.support_email].join("\n");}
function buildSummary_(items){return items.map(i=>i.displayTitle+" | "+i.cases+" case"+(i.cases===1?"":"s")+" | "+formatMoney_(i.unitPrice)+" | "+formatMoney_(i.lineTotal)).join("\n");}
function logEvent_(s,submissionId,orderId,action,result,error){s.appendRow([new Date(),safeSheetCell_(submissionId),safeSheetCell_(orderId),safeSheetCell_(action),safeSheetCell_(result),safeSheetCell_(error)]);}

function splitProductTitle_(title){const raw=cleanText_(title,300),m=raw.match(/^(.*?)\s*\(Non-Alcoholic\)\s*(.*)$/i);return m?{brand:m[1].trim(),name:m[2].trim()||m[1].trim()}:{brand:"Designated Drinks",name:raw};}
function inferCategory_(title){const v=String(title||"").toLowerCase();if(/\bcider\b|cidery|apple sparkle/.test(v))return"Cider";if(/hop\s?water|hopped water|sparkling hop/.test(v))return"Hop Water";if(/wine|rosé|rose\b|prosecco|chardonnay|cabernet|pinot|riesling|sauvignon/.test(v))return"Wine";if(/cocktail|mocktail|margarita|mojito|negroni|spritz|sangria|gin|tonic|cosmo|paloma|martini|mule\b|collins|mimosa|\brum\b|vodka|tequila|amaro/.test(v))return"Cocktails";return"Beer";}
function inferStyle_(title,cat){const v=String(title||"").toLowerCase(),r=[["IPA",/\bipa\b|india pale ale/],["Pale Ale",/pale ale/],["Lager",/lager/],["Pilsner",/pilsner/],["Stout",/stout/],["Porter",/porter/],["Sour",/sour|gose/],["Wheat",/wheat|witbier/],["Blonde Ale",/blonde/],["Amber Ale",/amber/]];for(let i=0;i<r.length;i++)if(r[i][1].test(v))return r[i][0];return cat;}
function outputResponse_(p,cb){return cb?ContentService.createTextOutput(cb+"("+safeJson_(p)+");").setMimeType(ContentService.MimeType.JAVASCRIPT):ContentService.createTextOutput(safeJson_(p)).setMimeType(ContentService.MimeType.JSON);}
function textResponse_(v){return ContentService.createTextOutput(String(v)).setMimeType(ContentService.MimeType.TEXT);}
function cleanText_(v,n){return String(v==null?"":v).replace(/\u0000/g,"").trim().slice(0,n);}
function cleanQuantity_(v){const q=parseInt(v,10);return!Number.isFinite(q)||q<1?0:Math.min(q,CONFIG.MAX_QUANTITY_PER_ITEM);}
function cleanCallback_(v){const c=String(v||"").trim();return/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(c)?c:"";}
function isValidEmail_(e){return/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);}
function safeSheetCell_(v){const t=String(v==null?"":v);return/^[=+\-@]/.test(t)?"'"+t:t;}
function safeSubject_(v){return String(v==null?"":v).replace(/[\r\n]+/g," ").trim().slice(0,100);}
function safeJson_(p){return JSON.stringify(p).replace(/</g,"\\u003c");}
function roundMoney_(v){return Math.round((Number(v)+Number.EPSILON)*100)/100;}
function formatMoney_(v){return"$"+roundMoney_(v).toFixed(2);}

function testTaxRules(){const x={ON:.13,NS:.14,NB:.15,NL:.15,PE:.15,BC:.05,QC:.05,AB:.05};Object.keys(x).forEach(c=>{if(!TAX_RULES[c]||TAX_RULES[c].rate!==x[c])throw new Error("Tax rule failed for "+c);});if(provinceFromAddress_("123 Main St\nLondon, ON N6P 1A1")!=="ON")throw new Error("Province parsing failed.");Logger.log("Tax rules passed.");}
function testSetup(){const ss=SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID),s=ensureSystemSheets_(ss),p=getProductCatalog_(ss).publicProducts;if(!p.length)throw new Error("No active products were found.");if(s.orders.getLastColumn()<ORDER_HEADERS.length)throw new Error("Orders headers are incomplete.");Logger.log("Setup valid. Active products: "+p.length);}
function testStatusStorage(){const id="TEST-"+Date.now();setStatus_(id,{status:"success",orderId:"TEST",total:113});const r=getStatus_(id);if(!r||r.total!==113)throw new Error("Status storage failed.");const k="wholesale-status:"+id;PropertiesService.getScriptProperties().deleteProperty(k);CacheService.getScriptCache().remove(k);Logger.log("Status storage passed.");}
