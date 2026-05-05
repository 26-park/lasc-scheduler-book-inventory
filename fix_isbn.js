(async () => {
  const snap = await db.collection('books').get();
  let fixed = 0;

  for (const doc of snap.docs) {
    const isbn = doc.data().isbn || '';
    const needsFix = !isbn || isbn.startsWith('undefined') || isbn.startsWith('TEMP') || isbn.startsWith('temp') || isbn === '__pending__';
    if (!needsFix) continue;

    const newIsbn = 'NA-' + doc.id.substring(0, 8);

    // inventory 기록도 같이 업데이트
    const invSnap = await db.collection('inventory').where('isbn', '==', isbn).get();
    for (const inv of invSnap.docs) {
      await inv.ref.update({ isbn: newIsbn });
    }

    await doc.ref.update({ isbn: newIsbn });
    console.log(`✓ ${doc.data().title}: "${isbn}" → "${newIsbn}" (inventory ${invSnap.size}건 업데이트)`);
    fixed++;
  }

  console.log(`완료! ${fixed}건 수정됨. 페이지 새로고침 하세요.`);
})();
