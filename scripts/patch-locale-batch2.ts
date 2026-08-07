import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, '../src/locales');

const receivedOtp: Record<string, string> = {
  de: 'OTP erhalten {when}',
  fr: 'OTP reçu {when}',
  es: 'OTP recibido {when}',
  ar: 'تم استلام OTP {when}',
  ja: 'OTP を受信 {when}',
  zh: '已收到 OTP {when}',
  th: 'ได้รับ OTP {when}',
};
const otpExpiresIn: Record<string, string> = {
  de: 'Läuft ab in {t}',
  fr: 'Expire dans {t}',
  es: 'Caduca en {t}',
  ar: 'ينتهي خلال {t}',
  ja: '{t} 後に期限切れ',
  zh: '{t} 后过期',
  th: 'หมดอายุใน {t}',
};
const otpExpiryUnknown: Record<string, string> = {
  de: 'Ablaufzeit konnte nicht ermittelt werden',
  fr: "Impossible de détecter l'expiration",
  es: 'No se pudo detectar la caducidad',
  ar: 'تعذر اكتشاف وقت الانتهاء',
  ja: '有効期限を検出できませんでした',
  zh: '无法检测过期时间',
  th: 'ตรวจหาเวลาหมดอายุไม่ได้',
};
const density: Record<string, string> = {
  de: 'Layoutdichte',
  fr: 'Densité de mise en page',
  es: 'Densidad de diseño',
  ar: 'كثافة التخطيط',
  ja: 'レイアウト密度',
  zh: '布局密度',
  th: 'ความหนาแน่นของเลย์เอาต์',
};
const densityDescription: Record<string, string> = {
  de: 'Komfortabel oder kompakt für Seitenleiste und breite Layouts',
  fr: 'Confortable ou compact pour le panneau latéral',
  es: 'Cómodo o compacto para el panel lateral',
  ar: 'مريح أو مضغوط للوحة الجانبية',
  ja: 'サイドパネルの余白（標準/コンパクト）',
  zh: '侧栏舒适或紧凑间距',
  th: 'สบายตาหรือกะทัดรัดสำหรับแถบด้านข้าง',
};
const densityComfortable: Record<string, string> = {
  de: 'Komfortabel',
  fr: 'Confortable',
  es: 'Cómodo',
  ar: 'مريح',
  ja: '標準',
  zh: '舒适',
  th: 'สบายตา',
};
const densityCompact: Record<string, string> = {
  de: 'Kompakt',
  fr: 'Compact',
  es: 'Compacto',
  ar: 'مضغوط',
  ja: 'コンパクト',
  zh: '紧凑',
  th: 'กะทัดรัด',
};

for (const lang of ['de', 'fr', 'es', 'ar', 'ja', 'zh', 'th'] as const) {
  const p = join(dir, `${lang}.json`);
  const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, Record<string, string>>;
  j.inbox = j.inbox || {};
  j.inbox.receivedOtp = receivedOtp[lang];
  j.inbox.otpExpiresIn = otpExpiresIn[lang];
  j.inbox.otpExpiryUnknown = otpExpiryUnknown[lang];
  j.inbox.detectedOtp = receivedOtp[lang].replace('{when}', '({when})');
  j.preferences = j.preferences || {};
  j.preferences.density = density[lang];
  j.preferences.densityDescription = densityDescription[lang];
  j.preferences.densityComfortable = densityComfortable[lang];
  j.preferences.densityCompact = densityCompact[lang];
  writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
  console.log('updated', lang);
}
