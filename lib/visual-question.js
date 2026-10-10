/**
 * Classifies questions that require the latest camera frame rather than text
 * chat or household sensor state. Presence questions remain on the fused state
 * path because one camera frame is not authoritative for room occupancy.
 */

function isVisualQuestion(text) {
  const input = String(text || '').trim();
  if (!input || /(有人|没人|无人|温度|几度|湿度|天气|下雨|空调|灯|窗帘)/.test(input)) return false;
  if (/(摄像头|画面里|画面中|镜头里)/.test(input)) return true;
  if (/(在做什么|正在干什么|穿什么|拿着什么|桌上有什么|沙发上有什么)/.test(input)) return true;
  return /(?:客厅|主卧|次卧|北卧|书房|厨房|阳台|餐厅|公卫|卫生间).{0,8}(?:有|有没有|看得到|看见|看到).{0,12}(?:吗|么|没有)?[？?]?$/.test(input);
}

module.exports = { isVisualQuestion };
