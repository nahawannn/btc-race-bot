# dip-buy bot — make.fun btc-race

Bot kecil 2–3 aturan untuk kompetisi btc-race (bars-replay/v1): beli saat
harga turun ≥0,8% di bawah SMA-30 selagi SMA-30 di atas SMA-120 (filter tren),
jual saat +1,2% / −1,2% dari cost, atau setelah 240 bar. Long only, satu
posisi, full size ($1.000 paper). Stdlib Python saja, tanpa network/jam/random.

Hasil backtest jujur (117 jendela 24 jam, BTC 1m, 19 Okt–18 Nov 2026):
rata-rata −$0,31/jendela, median $0,00, menang 2,6% jendela; mengalahkan
buy-and-hold di 72,6% jendela — tapi hampir seluruhnya karena duduk di cash
saat BTC turun. Di 31 jendela naik, bot kalah dari buy-and-hold 100%.
Tidak ada edge positif yang terbukti; ini tiket lotre gratis untuk jendela
race yang turun/sideways, bukan model terbaik. Dev window beku
(16–17 Nov 2026): +$4,32, lolos gate dev (PnL > $0).

Jalankan lokal:
`makefun grade-local --kit <kit-dir> --bot . --driver process`
