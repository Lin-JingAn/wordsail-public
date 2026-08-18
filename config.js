// apiBase 用于未来连接 3090 语音网关；留空时自动回退为静态语音体验。
// cloudBase.envId 是可公开的环境标识，不要在这里填写 SecretId、SecretKey 或服务端密钥。
window.WORDSAIL_CONFIG = Object.freeze({
  apiBase: "",
  cloudBase: Object.freeze({
    envId: "",
    region: "ap-shanghai",
    accessKey: ""
  })
});
