/**
 * Patch non-en locales with new keys from this batch (split empty, local badge, toolbar shorts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'src', 'lib', 'locales');

type Dict = Record<string, unknown>;

function get(obj: Dict, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => {
    if (o && typeof o === 'object') return (o as Dict)[k];
    return undefined;
  }, obj);
}

function set(obj: Dict, path: string, value: unknown) {
  const parts = path.split('.');
  let cur: Dict = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p] as Dict;
  }
  cur[parts[parts.length - 1]] = value;
}

/** English keys → per-locale translations (fallback to en if missing) */
const TRANSLATIONS: Record<string, Record<string, string>> = {
  de: {
    'inbox.emailActions.downloadShort': 'Herunterladen',
    'inbox.emailActions.forwardShort': 'Weiterleiten',
    'inbox.emailActions.markUnreadShort': 'Ungelesen',
    'inbox.localOnlyBadge': 'Lokal',
    'inbox.localOnlyTooltip':
      'Diese Nachricht ist nur auf diesem Gerät gespeichert und nicht mehr auf dem Server.',
    'inbox.deletedFromServerAgo': 'Vom Server gelöscht {when}',
    'inbox.noMessageSelected': 'Keine Nachricht ausgewählt',
    'inbox.splitEmptyHint': 'Wählen Sie eine Nachricht aus der Liste, um sie hier zu lesen.',
    'inbox.splitTipSelect': 'Klicken Sie auf eine Nachricht, um sie hier zu öffnen',
    'inbox.splitTipNavigate': 'Mit J / K durch die Liste navigieren',
    'inbox.splitTipSearch': 'Mit / die Suche fokussieren',
    'emailDetail.markAllReadShort': 'Alle gelesen',
    'emailDetail.markAllUnreadShort': 'Alle ungelesen',
    'mailManagement.noAddressSelected': 'Keine Adresse ausgewählt',
    'mailManagement.splitEmptyHint':
      'Wählen Sie eine Adresse aus der Liste, um Details und Aktionen zu sehen.',
    'mailManagement.splitTipSelect': 'Klicken Sie auf eine Adresse für das Detailpanel',
    'mailManagement.splitTipCreate': 'Mit Erstellen eine neue temporäre Adresse erzeugen',
    'mailManagement.splitTipDomain': 'Domain oder Auto-Verlängerung im Detailpanel ändern',
  },
  es: {
    'inbox.emailActions.downloadShort': 'Descargar',
    'inbox.emailActions.forwardShort': 'Reenviar',
    'inbox.emailActions.markUnreadShort': 'No leído',
    'inbox.localOnlyBadge': 'Local',
    'inbox.localOnlyTooltip':
      'Este mensaje solo está guardado en este dispositivo; ya no está en el servidor.',
    'inbox.deletedFromServerAgo': 'Eliminado del servidor {when}',
    'inbox.noMessageSelected': 'Ningún mensaje seleccionado',
    'inbox.splitEmptyHint': 'Selecciona un mensaje de la lista para leerlo aquí.',
    'inbox.splitTipSelect': 'Haz clic en un mensaje para abrirlo en este panel',
    'inbox.splitTipNavigate': 'Pulsa J / K para moverte por la lista',
    'inbox.splitTipSearch': 'Pulsa / para enfocar la búsqueda',
    'emailDetail.markAllReadShort': 'Leer todo',
    'emailDetail.markAllUnreadShort': 'No leídos',
    'mailManagement.noAddressSelected': 'Ninguna dirección seleccionada',
    'mailManagement.splitEmptyHint':
      'Selecciona una dirección de la lista para ver detalles y acciones.',
    'mailManagement.splitTipSelect': 'Haz clic en una dirección para abrir el panel',
    'mailManagement.splitTipCreate': 'Usa Crear para generar una dirección temporal',
    'mailManagement.splitTipDomain': 'Cambia el dominio o la auto-renovación en el panel',
  },
  fr: {
    'inbox.emailActions.downloadShort': 'Télécharger',
    'inbox.emailActions.forwardShort': 'Transférer',
    'inbox.emailActions.markUnreadShort': 'Non lu',
    'inbox.localOnlyBadge': 'Local',
    'inbox.localOnlyTooltip':
      "Ce message n'est enregistré que sur cet appareil ; il n'est plus sur le serveur.",
    'inbox.deletedFromServerAgo': 'Supprimé du serveur {when}',
    'inbox.noMessageSelected': 'Aucun message sélectionné',
    'inbox.splitEmptyHint': 'Sélectionnez un message dans la liste pour le lire ici.',
    'inbox.splitTipSelect': 'Cliquez sur un message pour l’ouvrir dans ce panneau',
    'inbox.splitTipNavigate': 'Appuyez sur J / K pour parcourir la liste',
    'inbox.splitTipSearch': 'Appuyez sur / pour focaliser la recherche',
    'emailDetail.markAllReadShort': 'Tout lu',
    'emailDetail.markAllUnreadShort': 'Tout non lu',
    'mailManagement.noAddressSelected': 'Aucune adresse sélectionnée',
    'mailManagement.splitEmptyHint':
      'Sélectionnez une adresse dans la liste pour voir les détails et actions.',
    'mailManagement.splitTipSelect': 'Cliquez sur une adresse pour ouvrir le panneau',
    'mailManagement.splitTipCreate': 'Utilisez Créer pour générer une adresse temporaire',
    'mailManagement.splitTipDomain': 'Changez le domaine ou le renouvellement auto dans le panneau',
  },
  ja: {
    'inbox.emailActions.downloadShort': 'ダウンロード',
    'inbox.emailActions.forwardShort': '転送',
    'inbox.emailActions.markUnreadShort': '未読',
    'inbox.localOnlyBadge': 'ローカル',
    'inbox.localOnlyTooltip':
      'このメッセージはこの端末にのみ保存されており、サーバー上にはありません。',
    'inbox.deletedFromServerAgo': 'サーバーから削除済み {when}',
    'inbox.noMessageSelected': 'メッセージが選択されていません',
    'inbox.splitEmptyHint': 'リストからメッセージを選択してここで読みます。',
    'inbox.splitTipSelect': 'メッセージをクリックしてこのパネルで開く',
    'inbox.splitTipNavigate': 'J / K でリストを移動',
    'inbox.splitTipSearch': '/ で検索にフォーカス',
    'emailDetail.markAllReadShort': 'すべて既読',
    'emailDetail.markAllUnreadShort': 'すべて未読',
    'mailManagement.noAddressSelected': 'アドレスが選択されていません',
    'mailManagement.splitEmptyHint': 'リストからアドレスを選択して詳細と操作を表示します。',
    'mailManagement.splitTipSelect': 'アドレスをクリックして詳細パネルを開く',
    'mailManagement.splitTipCreate': '作成で新しい一時アドレスを生成',
    'mailManagement.splitTipDomain': '詳細パネルでドメインや自動更新を変更',
  },
  zh: {
    'inbox.emailActions.downloadShort': '下载',
    'inbox.emailActions.forwardShort': '转发',
    'inbox.emailActions.markUnreadShort': '未读',
    'inbox.localOnlyBadge': '本地',
    'inbox.localOnlyTooltip': '此邮件仅保存在本设备上，服务器上已不存在。',
    'inbox.deletedFromServerAgo': '已从服务器删除 {when}',
    'inbox.noMessageSelected': '未选择邮件',
    'inbox.splitEmptyHint': '从列表中选择一封邮件在此阅读。',
    'inbox.splitTipSelect': '点击任意邮件在此面板打开',
    'inbox.splitTipNavigate': '按 J / K 浏览列表',
    'inbox.splitTipSearch': '按 / 聚焦搜索',
    'emailDetail.markAllReadShort': '全部已读',
    'emailDetail.markAllUnreadShort': '全部未读',
    'mailManagement.noAddressSelected': '未选择地址',
    'mailManagement.splitEmptyHint': '从列表中选择一个地址以查看详情和操作。',
    'mailManagement.splitTipSelect': '点击地址打开详情面板',
    'mailManagement.splitTipCreate': '使用创建生成新的临时地址',
    'mailManagement.splitTipDomain': '在详情面板更改域名或自动续期',
  },
  th: {
    'inbox.emailActions.downloadShort': 'ดาวน์โหลด',
    'inbox.emailActions.forwardShort': 'ส่งต่อ',
    'inbox.emailActions.markUnreadShort': 'ยังไม่อ่าน',
    'inbox.localOnlyBadge': 'ในเครื่อง',
    'inbox.localOnlyTooltip': 'ข้อความนี้บันทึกไว้ในอุปกรณ์นี้เท่านั้น และไม่มีบนเซิร์ฟเวอร์แล้ว',
    'inbox.deletedFromServerAgo': 'ลบจากเซิร์ฟเวอร์แล้ว {when}',
    'inbox.noMessageSelected': 'ยังไม่ได้เลือกข้อความ',
    'inbox.splitEmptyHint': 'เลือกข้อความจากรายการเพื่ออ่านที่นี่',
    'inbox.splitTipSelect': 'คลิกข้อความเพื่อเปิดในแผงนี้',
    'inbox.splitTipNavigate': 'กด J / K เพื่อเลื่อนรายการ',
    'inbox.splitTipSearch': 'กด / เพื่อโฟกัสช่องค้นหา',
    'emailDetail.markAllReadShort': 'อ่านทั้งหมด',
    'emailDetail.markAllUnreadShort': 'ยังไม่อ่านทั้งหมด',
    'mailManagement.noAddressSelected': 'ยังไม่ได้เลือกที่อยู่',
    'mailManagement.splitEmptyHint': 'เลือกที่อยู่จากรายการเพื่อดูรายละเอียดและการดำเนินการ',
    'mailManagement.splitTipSelect': 'คลิกที่อยู่เพื่อเปิดแผงรายละเอียด',
    'mailManagement.splitTipCreate': 'ใช้สร้างเพื่อสร้างที่อยู่ชั่วคราวใหม่',
    'mailManagement.splitTipDomain': 'เปลี่ยนโดเมนหรือต่ออายุอัตโนมัติในแผงรายละเอียด',
  },
  ar: {
    'inbox.emailActions.downloadShort': 'تنزيل',
    'inbox.emailActions.forwardShort': 'إعادة توجيه',
    'inbox.emailActions.markUnreadShort': 'غير مقروء',
    'inbox.localOnlyBadge': 'محلي',
    'inbox.localOnlyTooltip': 'هذه الرسالة محفوظة على هذا الجهاز فقط ولم تعد موجودة على الخادم.',
    'inbox.deletedFromServerAgo': 'حُذفت من الخادم {when}',
    'inbox.noMessageSelected': 'لم يتم تحديد رسالة',
    'inbox.splitEmptyHint': 'اختر رسالة من القائمة لقراءتها هنا.',
    'inbox.splitTipSelect': 'انقر أي رسالة لفتحها في هذه اللوحة',
    'inbox.splitTipNavigate': 'اضغط J / K للتنقل في القائمة',
    'inbox.splitTipSearch': 'اضغط / للتركيز على البحث',
    'emailDetail.markAllReadShort': 'قراءة الكل',
    'emailDetail.markAllUnreadShort': 'غير مقروء الكل',
    'mailManagement.noAddressSelected': 'لم يتم تحديد عنوان',
    'mailManagement.splitEmptyHint': 'اختر عنوانًا من القائمة لعرض التفاصيل والإجراءات.',
    'mailManagement.splitTipSelect': 'انقر عنوانًا لفتح لوحة التفاصيل',
    'mailManagement.splitTipCreate': 'استخدم إنشاء لإنشاء عنوان مؤقت جديد',
    'mailManagement.splitTipDomain': 'غيّر النطاق أو التجديد التلقائي من لوحة التفاصيل',
  },
};

const locales = ['ar', 'de', 'es', 'fr', 'ja', 'th', 'zh'] as const;

for (const loc of locales) {
  const path = join(root, `${loc}.json`);
  const data = JSON.parse(readFileSync(path, 'utf8')) as Dict;
  const map = TRANSLATIONS[loc] || {};
  for (const [key, value] of Object.entries(map)) {
    if (get(data, key) === undefined) {
      set(data, key, value);
    }
  }
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`patched ${loc}`);
}

console.log('done');
