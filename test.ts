import Downloader from "./Downloader"

async function main() {
  const d = new Downloader({
    url: "https://testmnbbs.oss-cn-zhangjiakou.aliyuncs.com/pic20220521005122.png?x-oss-process=base_webp",
    directory: "./"
  })
  const { md5 } = await d.download()
  console.log(md5)
}

main()
