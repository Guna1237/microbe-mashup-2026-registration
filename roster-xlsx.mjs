import { crc32, deflateRawSync } from 'node:zlib';

const xml = (value) => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  .replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

function zip(files) {
  const records = [];
  const directory = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const original = Buffer.from(text);
    const data = deflateRawSync(original);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc32(original), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(original.length, 22);
    local.writeUInt16LE(filename.length, 26);
    records.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(directory.reduce((total, part) => total + part.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, ...directory, end]);
}

export function rosterWorkbook(orders) {
  const columns = ['Registration ID', 'Name', 'Email', 'Phone', 'Batch', 'College', 'Registration',
    'Order reference', 'Activities', 'Team', 'Payment status', 'Amount (INR)', 'UPI reference',
    'Screenshot attached', 'Group payment', 'Payment verified (UTC)', 'Checked in (UTC)'];
  const date = (timestamp) => timestamp ? new Date(timestamp).toISOString() : '';
  const rows = orders.map((order) => [
    order.attendeeId, order.name, order.email, order.details?.phone, order.batch, order.details?.college,
    order.label, order.ref, order.selections.map(({ name }) => name).join(', '),
    order.selections.filter(({ team }) => team).map(({ name, team }) =>
      [name, team.leaderId || team.name, team.side, ...(team.memberIds || [])].filter(Boolean).join(' · ')).join(' / '),
    order.state, order.amount, order.utr, order.hasProof ? 'Yes' : 'No',
    order.coveredByGroupPayment ? 'Covered by group leader' : order.members.length ? 'Group leader' : '',
    date(order.paidAt), date(order.checkedInAt),
  ]);
  const sheet = [columns, ...rows].map((row, index) => '<row r="' + (index + 1) + '">' + row.map((value) =>
    typeof value === 'number' ? '<c><v>' + value + '</v></c>' :
      '<c t="inlineStr"><is><t xml:space="preserve">' + xml(value ?? '') + '</t></is></c>'
  ).join('') + '</row>').join('');
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/package/2006/relationships';
  return zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="' + rel + '"><Relationship Id="rId1" Type="' + office +
      '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="' + main + '" xmlns:r="' + office +
      '"><sheets><sheet name="Roster" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="' + rel + '"><Relationship Id="rId1" Type="' + office +
      '/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="' + main + '"><sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<cols><col min="1" max="17" width="23" customWidth="1"/></cols><sheetData>' + sheet + '</sheetData>' +
      '<autoFilter ref="A1:Q' + (rows.length + 1) + '"/></worksheet>',
  });
}
