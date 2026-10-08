// Fixed CPU application provider, never a shell/script/command supplied by a caller.
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>2_000_000)throw new Error('INPUT_LIMIT');}
const request=JSON.parse(input),values=request.values;
if(!Array.isArray(values)||values.length>100000||values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error('INVALID_VALUES');
let output;
if(request.operation==='SORT')output={values:[...values].sort((a,b)=>a-b)};
else if(request.operation==='SUM'){const start=request.checkpoint?.cursor??0;let sum=request.checkpoint?.sum??0;if(!Number.isSafeInteger(start)||start<0||start>values.length||!Number.isFinite(sum))throw new Error('INVALID_CHECKPOINT');for(let i=start;i<values.length;i++)sum+=values[i];if(!Number.isFinite(sum))throw new Error('SUM_OVERFLOW');output={sum,cursor:values.length};}
else throw new Error('UNSUPPORTED_OPERATION');
process.stdout.write(JSON.stringify(output));
