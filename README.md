# Kartlı Okey

İskambil kartlarıyla okey. Bilgisayara karşı ve arkadaşlarla online oynanır.

## Klasörler

- `server.js` — Sunucu. Sayfayı sunar ve online masaları yönetir. Ek paket gerektirmez.
- `game/rules.js` — Kurallar: per, çift, okey, puan hesabı.
- `game/table.js` — Masa: oturma, dağıtım, sıra, 45 saniye hamle süresi, kopan oyuncunun yerine bilgisayar.
- `public/index.html` — Oyunun sayfası (tek kişilik ve online).

## Bilgisayarda çalıştırma

Node.js 18 veya üstü gerekir.

```
node server.js
```

Sonra tarayıcıda `http://localhost:3000` adresini açın.

## Ayarlar (ortam değişkenleri)

- `PORT` — Sunucunun portu (varsayılan 3000; Render kendisi verir).
- `ALLOWED_ORIGINS` — Sayfa başka bir siteden açılıyorsa (ör. Netlify) izin verilen adresler, virgülle. Boş bırakılırsa herkes bağlanabilir.
- `OKEY_TURN_LIMIT` — Hamle süresi, milisaniye (varsayılan 45000).

## Netlify'daki sayfayı bu sunucuya bağlamak

`public/index.html` içinde `const ONLINE_SERVER='';` satırına sunucunun adresini yazın, örneğin
`const ONLINE_SERVER='kartli-okey.onrender.com';`. Sayfa doğrudan bu sunucudan açılıyorsa boş kalabilir.
