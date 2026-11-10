import { searchEvidence, fetchEvidence } from '../src/knowledge.mjs';
try {
  const found = await searchEvidence('poe life leech mechanics');
  console.log(JSON.stringify({ searchCount: found.length, sources: found.map(item => item.url) }));
} catch(error) { console.log(JSON.stringify({ searchUnavailable: error.message })); }
for (const url of ['https://www.pathofexile.com/forum', 'https://www.reddit.com/r/pathofexile/', 'https://www.poewiki.net/wiki/Leech']) {
  try { const evidence = await fetchEvidence(url); console.log(JSON.stringify({ url, verifiedTextCharacters: evidence.content.length })); }
  catch(error) { console.log(JSON.stringify({ url, unavailable: error.message })); }
}
