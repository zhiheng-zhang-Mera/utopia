import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {buildSample} from '../city/09-planning-knowledge/02-document-intake/document-readers/samples.mjs';
import {buildTar,skillDoc} from '../city/02-engineering/02-worker-gateway/skill-intake/tests/fixtures.mjs';
export async function capabilityFixtures(dir='.runtime/v03/fixtures'){
 mkdirSync(dir,{recursive:true});const names=['sample.txt','sample.json','sample.yaml','malformed.json','oversize.txt','valid-SKILL.md','malformed-SKILL.md','unsafe.tar','valid.tar','sample.docx','sample.xlsx','sample.pdf','truncated.pdf'];if(names.every(name=>existsSync(dir+'/'+name)))return Object.fromEntries(names.map(name=>[name,readFileSync(dir+'/'+name)]));const items={
  'sample.txt':Buffer.from('Utopia shared knowledge\nProduct usability comes first.'),
  'sample.json':Buffer.from('{"city":"Utopia","purpose":"shared knowledge"}'),
  'sample.yaml':Buffer.from('city: Utopia\npurpose: shared knowledge\n'),
  'malformed.json':Buffer.from('{'),'oversize.txt':Buffer.alloc(1024*1024+1,65),
  'valid-SKILL.md':Buffer.from(skillDoc('demo-skill','Generated public inspection sample')),
  'malformed-SKILL.md':Buffer.from('---\nname: invalid name\n---\nMissing description'),
  'unsafe.tar':buildTar([{path:'../../escape',data:Buffer.from('refused')}]),
  'valid.tar':buildTar([{path:'sample/SKILL.md',data:Buffer.from(skillDoc('demo-skill','Generated archive sample'))}])
 };
 for(const ext of ['docx','xlsx','pdf'])items['sample.'+ext]=Buffer.from((await buildSample(ext)).bytes);
 items['truncated.pdf']=items['sample.pdf'].subarray(0,40);
 for(const [name,bytes]of Object.entries(items))writeFileSync(dir+'/'+name,bytes);
 return items;
}
