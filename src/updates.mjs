import { runProcess } from './process.mjs';
export const repository = 'autis-analytics/poe-assistant';
export async function latestRelease({ signal } = {}) {
  let release;
  try { release = JSON.parse(await runProcess('gh.exe',['api','--hostname','github.com',`repos/${repository}/releases/latest`],{signal,timeoutMs:20000})); }
  catch {
    const response=await fetch(`https://api.github.com/repos/${repository}/releases/latest`,{signal:signal || AbortSignal.timeout(20000),headers:{Accept:'application/vnd.github+json'}});
    if(!response.ok) throw Error('Release unavailable. Private repositories require GitHub CLI signed in with repository access. You can also install a downloaded official release.');
    release=await response.json();
  }
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !release.html_url?.startsWith(`https://github.com/${repository}/releases/tag/`)) throw Error('Unexpected release metadata.');
  return {tag:release.tag_name,version:release.tag_name.slice(1),url:release.html_url};
}
export function newerVersion(candidate,current) {
  if(!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(current)) throw Error('Invalid release version.');
  const a=candidate.split('.').map(Number),b=current.split('.').map(Number);
  for(let i=0;i<3;i++) if(a[i]!==b[i]) return a[i]>b[i];
  return false;
}
