export default async function hackerNews() {
  const TOP_STORIES_URL = 'https://hacker-news.firebaseio.com/v0/topstories.json';
  const ITEM_URL = 'https://hacker-news.firebaseio.com/v0/item';
  const COUNT = 20;

  const idsResponse = await fetch(TOP_STORIES_URL);
  if (!idsResponse.ok) {
    return { success: false, error: `Failed to fetch top stories: ${idsResponse.status}` };
  }

  const allIds = await idsResponse.json();
  const topIds = allIds.slice(0, COUNT);

  const stories = await Promise.all(
    topIds.map(async (id) => {
      const res = await fetch(`${ITEM_URL}/${id}.json`);
      if (!res.ok) return null;
      return res.json();
    }),
  );

  const lines = stories
    .filter(Boolean)
    .map((story, i) => {
      const hnUrl = `https://news.ycombinator.com/item?id=${story.id}`;
      const link = story.url || hnUrl;
      return [
        `${i + 1}. ${story.title}`,
        `   Link: ${link}`,
        `   Score: ${story.score} | Comments: ${story.descendants ?? 0} | By: ${story.by}`,
        story.url ? `   HN Discussion: ${hnUrl}` : '',
      ].filter(Boolean).join('\n');
    });

  return {
    success: true,
    result: `Top ${COUNT} Hacker News Stories\n${'='.repeat(40)}\n\n${lines.join('\n\n')}`,
  };
}
