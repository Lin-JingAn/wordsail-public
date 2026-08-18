// 公网前端与本地 3090 服务分离时，在发布副本中填写 apiBase。
// 示例：https://voice.example.com。留空时使用同域 API，并在不可用时回退到静态体验。
window.WORDSAIL_CONFIG = Object.freeze({ apiBase: "" });
