import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyOmgmuLabel,
  discoverOmgmuSources,
  extractOmgmuSources,
} from "../src/adapters/omgmu/discover.mjs";

test("classifies ОмГМУ program, course, stream and schedule part", () => {
  assert.deepEqual(classifyOmgmuLabel("Лечебное дело 5 курс 2 поток циклы"), {
    program: "medicine",
    course: 5,
    stream: "2",
    part: "cycles",
  });
  assert.deepEqual(classifyOmgmuLabel("Педиатрия 4 курс лекции"), {
    program: "pediatrics",
    course: 4,
    stream: null,
    part: "lectures",
  });
  assert.deepEqual(classifyOmgmuLabel("Фармация 1 курс ДОТ"), {
    program: "pharmacy",
    course: 1,
    stream: null,
    part: "distance",
  });
});

test("infers the international medicine program from bilingual source URLs", () => {
  assert.deepEqual(
    classifyOmgmuLabel("1 курс 2 поток", "https://omsk-osma.ru/files/r/UU/bilingva/2026/1-2.pdf"),
    {
      program: "medicine-international",
      course: 1,
      stream: "2",
      part: "combined",
    },
  );
});

test("extracts only schedule file links from official-page HTML", () => {
  const html = `
    <a href="/files/r/UU/medicine-5-2-cycles.pdf">Лечебное дело 5 курс 2 поток циклы</a>
    <a href="/studentam/news">Новости</a>
    <a href="/files/r/UU/pediatrics-4.pdf">Педиатрия 4 курс лекции</a>
    <a href="/files/r/UU/bilingva/2026/1-1.pdf">1 курс 1 поток</a>
  `;
  const sources = extractOmgmuSources(html);
  assert.equal(sources.length, 3);
  assert.equal(sources[0].program, "medicine");
  assert.equal(sources[0].course, 5);
  assert.equal(sources[0].stream, "2");
  assert.equal(sources[1].program, "pediatrics");
  assert.equal(sources[2].program, "medicine-international");
});

test("discovery returns a validated manifest", async () => {
  const html = `<a href="/files/r/UU/pharmacy-1.pdf">Фармация 1 курс ДОТ</a>`;
  const manifest = await discoverOmgmuSources({
    fetchFn: async () => new Response(html, { status: 200 }),
  });
  assert.equal(manifest.university, "omgmu");
  assert.equal(manifest.sourceCount, 1);
  assert.equal(manifest.validation.status, "ok");
});
