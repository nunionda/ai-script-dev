import type { Project, ScriptElement } from './types';
import { el, uid } from './screenplay';

/** 디자인 시안의 예시 작품 "마지막 상영" */
export function sampleProject(): Omit<Project, 'id' | 'rev' | 'createdAt' | 'updatedAt'> {
  const act1 = { id: uid('a'), title: '돌아온 사람' };
  const act2 = { id: uid('a'), title: '남겨진 것들' };
  const act3 = { id: uid('a'), title: '마지막 불빛' };

  const s1 = el('scene', '외부. 극장 앞 골목 - 저녁');
  const s2 = el('scene', '내부. 로비 - 밤');
  const s3 = el('scene', '내부. 영사실 - 밤');
  const s4 = el('scene', '내부. 텅 빈 객석 - 밤');
  const s5 = el('scene', '외부. 극장 지붕 - 새벽');

  const elements: ScriptElement[] = [
    s1,
    el('action', '폐관 안내문이 바람에 들린다.\n서윤(32)은 여행 가방을 세운다. 휴대전화 화면에 "아빠"가 뜬다.'),
    el('action', '벨이 멎을 때까지, 서윤은 극장 간판을 올려다본다. 불이 반쯤 나간 글자 — 시네마 천국.'),
    s2,
    el('action', '로비는 어둡다. 매표소 안에만 작은 등이 켜져 있다.\n아버지 동하(67)가 낡은 티켓 한 장을 책상 위에 놓는다.'),
    el('character', '동하'),
    el('dialogue', '왔냐.'),
    el('character', '서윤'),
    el('dialogue', '응.'),
    el('action', '서윤은 가방을 벽에 기대고, 티켓에는 손을 대지 않는다.'),
    s3,
    el('action', '오래된 영사기가 낮게 숨을 쉰다.\n서윤은 문턱에 선 채, 벽에 붙은 빛바랜 상영표를 본다.'),
    el('action', '동하는 필름 통의 먼지를 닦는다.\n이미 깨끗해진 자리를 한 번 더 문지른다.'),
    el('character', '서윤'),
    el('dialogue', '내일 첫차로 갈게.'),
    el('action', '동하의 손이 잠깐 멈춘다.'),
    el('character', '동하'),
    el('dialogue', '네가 떠나면 나는 혼자야.\n이 극장도 이제 끝이고.'),
    el('action', '서윤은 대답하지 않는다.\n필름이 돌아가는 소리만 두 사람 사이를 채운다.'),
    s4,
    el('action', '스크린에는 빛만 남아 있다.\n서윤은 맨 뒷줄로 걸어간다. 한 좌석 위에 접힌 담요가 놓여 있다.'),
    el('action', '담요 아래, 어릴 적 서윤이 그린 극장 그림.'),
    el('character', '서윤'),
    el('parenthetical', '(혼잣말로)'),
    el('dialogue', '아직도 갖고 있었네.'),
    s5,
    el('action', '동이 튼다. 간판의 마지막 전구가 꺼진다.'),
    el('transition', '페이드 아웃.'),
  ];

  return {
    title: '마지막 상영',
    logline: '폐관을 앞둔 극장. 떠나려는 딸과 마지막 상영을 준비하는 아버지.',
    genre: '장편 / 드라마',
    author: '서윤',
    contact: '',
    format: 'korean',
    status: '2고 개발 중',
    elements,
    acts: [act1, act2, act3],
    sceneMeta: {
      [s1.id]: { act: act1.id, synopsis: '서윤은 폐관 안내문 앞에 멈춘다. 아버지에게 온 전화를 받지 않는다.', intent: '돌아왔지만 아직 문을 열지 못하는 서윤.' },
      [s2.id]: { synopsis: '서윤의 짐 옆에 놓인 오래된 티켓. 돌아온 이유를 서로 묻지 않는다.', intent: '말하지 않는 시간이 두 사람의 거리를 보여준다.' },
      [s3.id]: { act: act2.id, synopsis: '떠나겠다는 딸. 필름을 놓지 않는 아버지. 마지막 상영을 함께 준비한다.', intent: '떠나려는 서윤과 붙잡지 못하는 아버지. 서로 다른 행동으로 같은 두려움을 드러낸다.' },
      [s4.id]: { synopsis: '아무도 없는 줄 알았던 객석. 서윤은 아버지가 남겨 둔 자리를 발견한다.', intent: '아버지가 준비한 빈자리에서 마음의 단서를 발견한다.' },
      [s5.id]: { act: act3.id, synopsis: '마지막 상영 다음 날 새벽.', intent: '' },
    },
    characters: {
      서윤: { description: '32세. 서울에서 영상 편집 일을 한다. 아버지와 감정을 말로 나누는 데 서툴다.' },
      동하: { description: '67세. 40년째 극장을 지킨 영사기사. 감정을 행동으로만 드러낸다.' },
    },
    decisions: ['두 인물의 화해를 서두르지 않는다. 감정은 대사보다 행동에 남긴다.'],
    openQuestions: ['서윤이 남는 것과 아버지를 이해하는 것은 같은 선택일까?'],
  };
}

export function blankProject(title: string): Omit<Project, 'id' | 'rev' | 'createdAt' | 'updatedAt'> {
  const act = { id: uid('a'), title: '1막' };
  const first = el('scene', '');
  return {
    title,
    logline: '',
    genre: '',
    author: '',
    contact: '',
    format: 'korean',
    status: '초고 집필 중',
    elements: [first, el('action', '')],
    acts: [act, { id: uid('a'), title: '2막' }, { id: uid('a'), title: '3막' }],
    sceneMeta: { [first.id]: { act: act.id } },
    characters: {},
    decisions: [],
    openQuestions: [],
  };
}
