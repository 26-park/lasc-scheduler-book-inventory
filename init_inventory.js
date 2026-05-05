(async () => {
  const inventoryData = [
  {
    "branch": "LA",
    "title": "Evolve 1, Full Contact",
    "stock": 8
  },
  {
    "branch": "LA",
    "title": "Evolve 4, Student Book with Digital Packet",
    "stock": 9
  },
  {
    "branch": "LA",
    "title": "Prism 1 Reading and Writing",
    "stock": 14
  },
  {
    "branch": "LA",
    "title": "Project Success 5",
    "stock": 17
  },
  {
    "branch": "LA",
    "title": "Top Notch 2, 3E",
    "stock": 18
  },
  {
    "branch": "LA",
    "title": "Top Notch 2, 3E Workbook",
    "stock": 0
  },
  {
    "branch": "LA",
    "title": "Top Notch Fundamentals, 3E",
    "stock": 6
  },
  {
    "branch": "LA",
    "title": "Top Notch Fundamentals, 3E Workbook",
    "stock": 6
  },
  {
    "branch": "LA",
    "title": "Notebook",
    "stock": 18
  },
  {
    "branch": "LA",
    "title": "Evolve 5, Student Book with Digital Packet",
    "stock": 25
  },
  {
    "branch": "LA",
    "title": "Prism 2 Listening and Speaking",
    "stock": 0
  },
  {
    "branch": "RH",
    "title": "Clear Speech from the Start, 2E",
    "stock": 14
  },
  {
    "branch": "RH",
    "title": "Evolve 3, Student Book with Digital Packet",
    "stock": 8
  },
  {
    "branch": "RH",
    "title": "Grammar and Beyond 3, 2E",
    "stock": 10
  },
  {
    "branch": "RH",
    "title": "Grammar and Beyond 4, 2E",
    "stock": 23
  },
  {
    "branch": "RH",
    "title": "Prism 1 Listening and Speaking",
    "stock": 5
  },
  {
    "branch": "RH",
    "title": "Prism 3 Listening and Speaking",
    "stock": 19
  },
  {
    "branch": "RH",
    "title": "Prism 3 Reading and Writing",
    "stock": 12
  },
  {
    "branch": "RH",
    "title": "Prism 4 Listening and Speaking",
    "stock": 20
  },
  {
    "branch": "RH",
    "title": "Project Success 5",
    "stock": 5
  },
  {
    "branch": "RH",
    "title": "Top Notch 2, 3E",
    "stock": 11
  },
  {
    "branch": "RH",
    "title": "Top Notch 2, 3E Workbook",
    "stock": 6
  },
  {
    "branch": "RH",
    "title": "Top Notch 3, 3E",
    "stock": 3
  },
  {
    "branch": "RH",
    "title": "Top Notch 3, 3E Workbook",
    "stock": 3
  },
  {
    "branch": "RH",
    "title": "Top Notch Fundamentals, 3E",
    "stock": 17
  },
  {
    "branch": "RH",
    "title": "Top Notch Fundamentals, 3E Workbook",
    "stock": 16
  },
  {
    "branch": "RH",
    "title": "Notebook",
    "stock": 17
  },
  {
    "branch": "RH",
    "title": "Prism 2 Listening and Speaking",
    "stock": 0
  },
  {
    "branch": "RH",
    "title": "Evolve 1, Full Contact",
    "stock": 1
  },
  {
    "branch": "RH",
    "title": "Prism 1 Reading and Writing",
    "stock": 0
  },
  {
    "branch": "IRV",
    "title": "Evolve 3, Student Book with Digital Packet",
    "stock": 17
  },
  {
    "branch": "IRV",
    "title": "Evolve 4, Student Book with Digital Packet",
    "stock": 25
  },
  {
    "branch": "IRV",
    "title": "Prism 1 Listening and Speaking",
    "stock": 19
  },
  {
    "branch": "IRV",
    "title": "Prism 1 Reading and Writing",
    "stock": 14
  },
  {
    "branch": "IRV",
    "title": "Prism 2 Listening and Speaking",
    "stock": 2
  },
  {
    "branch": "IRV",
    "title": "Prism 3 Reading and Writing",
    "stock": 11
  },
  {
    "branch": "IRV",
    "title": "Prism Intro Reading and Writing",
    "stock": 10
  },
  {
    "branch": "IRV",
    "title": "Project Success 5",
    "stock": 19
  },
  {
    "branch": "IRV",
    "title": "Top Notch 1, 3E",
    "stock": 10
  },
  {
    "branch": "IRV",
    "title": "Top Notch 1, 3E Workbook",
    "stock": 10
  },
  {
    "branch": "IRV",
    "title": "Top Notch 2, 3E",
    "stock": 4
  },
  {
    "branch": "IRV",
    "title": "Top Notch 2, 3E Workbook",
    "stock": 0
  },
  {
    "branch": "IRV",
    "title": "Top Notch 3, 3E",
    "stock": 21
  },
  {
    "branch": "IRV",
    "title": "Top Notch 3, 3E Workbook",
    "stock": 21
  },
  {
    "branch": "IRV",
    "title": "Notebook",
    "stock": 18
  },
  {
    "branch": "IRV",
    "title": "Prism 3 Listening and Speaking",
    "stock": 9
  },
  {
    "branch": "IRV",
    "title": "Evolve 1, Full Contact",
    "stock": 0
  }
];

  const booksSnap = await db.collection('books').get();
  const books = booksSnap.docs.map(d => ({id: d.id, ...d.data()}));

  const unmatched = [];

  for (const item of inventoryData) {
    const book = books.find(b => b.title.trim().toLowerCase() === item.title.toLowerCase());
    if (!book) { unmatched.push(item.branch + ' / ' + item.title); continue; }

    const invSnap = await db.collection('inventory')
      .where('isbn','==',book.isbn).where('branch','==',item.branch).get();

    if (!invSnap.empty) {
      await invSnap.docs[0].ref.update({ stock: item.stock });
    } else {
      await db.collection('inventory').add({
        isbn: book.isbn, title: book.title, branch: item.branch, stock: item.stock
      });
    }
    console.log('✓', item.branch, item.title + ':', item.stock);
  }

  if (unmatched.length) {
    console.warn('❌ 책 카탈로그에 없는 항목 (수동 등록 필요):');
    unmatched.forEach(m => console.warn(' -', m));
  }
  console.log('완료! 페이지 새로고침 하세요.');
})();