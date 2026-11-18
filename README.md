# dip-buy bot — make.fun btc-race-24h-20261118-1444

Bot TypeScript 2–3 aturan untuk kompetisi btc-race (bars-replay/v1).
Cara kerja harness: pesan hello membuka sesi (simbol CBBTC, kas awal
$1.000 paper, model fee/slippage, seed), lalu harness mengirim replay
dalam batch — tiap batch berisi bar 1-menit CBBTC — dan bot menjawab
tiap batch dengan orders-nya: array kosong, order buy saat sinyal entry,
atau order sell saat sinyal exit. Order dieksekusi di open bar berikutnya.
Tanpa network, tanpa jam dinding, tanpa random: bar yang sama selalu
menghasilkan orders yang sama.

Aturan:
- Entry (saat flat): close turun ≥0,8% di bawah SMA-30, DAN SMA-30 di atas
  SMA-120 (filter tren naik). Full size ($1.000 paper), long only.
- Exit (saat pegang posisi): take-profit +1,2% dari cost, ATAU stop-loss
  −1,2% dari cost, ATAU time stop setelah 240 bar.
- Tiap order dibatasi max slippage 100 bps.

Hasil jujur:
- Backtest 117 jendela 24 jam (BTC 1m, 19 Okt–18 Nov 2026): rata-rata
  −$0,31/jendela, median $0,00, menang 2,6% jendela; mengalahkan
  buy-and-hold di 72,6% jendela — tapi hampir seluruhnya karena duduk di
  cash saat BTC turun. Di 31 jendela naik, bot kalah dari buy-and-hold 100%.
  Tidak ada edge positif yang terbukti.
- Dev window kit race ini (17 Nov 14:44 → 18 Nov 14:44 UTC, 1.440 bar,
  jendela turun, buy-and-hold −$31,63): net PnL $0,00, 0 trade — filter
  tren tidak pernah terpicu, jadi bot tidak mengirim order sama sekali.
  Entry ini dev-board saja: tidak balapan, tidak dapat hadiah.

Refactor 18 Nov 2026 (~22:45 WIB, sesi setelah pembukaan): main.ts
dirapikan agar mudah dibaca (nama konstanta deskriptif, entry/exit
dipisah ke fungsi bernama, dokumentasi protokol harness di header).
Angka, threshold, dan logika keputusan TIDAK berubah; perilaku diperiksa
ulang dengan grade-local — action log harus byte-identik dengan run
sebelum refactor. Terverifikasi grade-local --worktree 18 Nov 2026:
action_log_sha256 9a65d50b260bb95c949121aed92d99eae4109c8fcb6645d99692c06d524c9c3f,
net PnL $0,00, 0 trade, L1 regrade reproduced byte for byte.

Jalankan grade-local (dari direktori kit):
`node --import ~/workspace/makefun/nokeepalive.mjs cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun/btc-race-bot/repo --driver process`
(Docker tidak tersedia di VM ini; driver process hanya jalan untuk bot Node.)
