// jikji/gpu.mjs — GPU admission controller (보호서비스 무간섭 불변)
//
// 정본: the internal design spec §6 (P0-6). 실 모델(KURE-v1 임베딩·Qwen3 리랭커) 적재는
// 보호서비스(TTS·ASR·judge) health + free_vram 최소치 + util 상한을 모두 만족할 때만. 미만족 = lexical 폴백.
//  - 저우선순위·여유분만. 요청 중 압력 상승 → 신규중단 + unload(운영은 워커/배포 측).
//  - 이 모듈은 **결정(admit yes/no)** 만 — 실제 모델 로딩/언로딩은 jikji-embed(Python) 워커가 이 결정을 따른다.
//
// nvidia-smi 부재/파싱 실패 = **fail-closed(admit=false)** — GPU 없으면 실모델 금지, 폴백.

import { execFile } from 'node:child_process';

/** nvidia-smi 로 GPU별 {index, freeMB, totalMB, utilPct} 조회. 실패 시 null. */
export function queryGpus({ timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    execFile('nvidia-smi',
      ['--query-gpu=index,memory.free,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const gpus = stdout.trim().split('\n').map((line) => {
            const [index, free, total, util] = line.split(',').map((s) => Number(s.trim()));
            return { index, freeMB: free, totalMB: total, utilPct: util };
          }).filter((g) => Number.isFinite(g.index));
          resolve(gpus);
        } catch { resolve(null); }
      });
  });
}

/** 보호서비스 health 확인(모두 up 이어야 admit). urls 비면 skip(true). */
async function protectedHealthy(urls, timeoutMs) {
  if (!urls?.length) return true;
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return false;
    } catch { return false; }
  }
  return true;
}

/**
 * 실모델 적재 허가 판정.
 * @param {object} o
 * @param {number[]=} o.allowedGpus  사용 허용 GPU index(기본 [1,3] — 서빙 저우선 슬롯). 보호 GPU(0 학습·2 프로덕트) 제외.
 * @param {number=} o.minFreeVramMB  최소 여유 VRAM(기본 6000).
 * @param {number=} o.utilCeilingPct 이 util 초과 GPU 는 회피(기본 85).
 * @param {string[]=} o.protectedHealthUrls  보호서비스 health(모두 up 이어야).
 * @returns {Promise<{admit:boolean, gpu:number|null, reason:string, gpus?:object[]}>}
 */
export async function admit({
  allowedGpus = (process.env.JIKJI_GPU_ALLOWED || '1,3').split(',').map((s) => Number(s.trim())).filter(Number.isFinite),
  minFreeVramMB = Number(process.env.JIKJI_GPU_MIN_FREE_MB || 6000),
  utilCeilingPct = Number(process.env.JIKJI_GPU_UTIL_CEILING || 85),
  protectedHealthUrls = (process.env.JIKJI_PROTECTED_HEALTH || '').split(',').map((s) => s.trim()).filter(Boolean),
  timeoutMs = 3000,
} = {}) {
  const gpus = await queryGpus({ timeoutMs });
  if (!gpus) return { admit: false, gpu: null, reason: 'nvidia_smi_unavailable' };   // fail-closed
  if (!(await protectedHealthy(protectedHealthUrls, timeoutMs))) return { admit: false, gpu: null, reason: 'protected_service_unhealthy', gpus };
  const candidates = gpus
    .filter((g) => allowedGpus.includes(g.index))
    .filter((g) => g.freeMB >= minFreeVramMB && g.utilPct <= utilCeilingPct)
    .sort((a, b) => b.freeMB - a.freeMB);
  if (!candidates.length) return { admit: false, gpu: null, reason: 'insufficient_headroom', gpus };
  return { admit: true, gpu: candidates[0].index, reason: 'ok', gpus };
}
