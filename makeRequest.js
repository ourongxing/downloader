const { http, https } = require("follow-redirects")
const { Readable } = require("stream")
const crypto = require("crypto")

function makeRequest(url, config = {}) {
  let cancelPromiseReject

  let responsePromiseReject

  let request

  const responsePromise = new Promise((resolve, reject) => {
    responsePromiseReject = reject
    const protocol = url.trim().startsWith("https") ? https : http

    request = protocol.request(url, config, res => {
      resolve(res)
    })
    request.end()
    request.on("error", e => {
      responsePromiseReject(e)
    })
  })
  const timeoutPromise = new Promise((resolve, reject) => {
    if (config.timeout) {
      request.setTimeout(config.timeout, () => {
        const customError = new Error("Request timed out")
        customError.code = "ERR_REQUEST_TIMEDOUT"
        reject(customError)
      })
    }
  })

  const cancelPromise = new Promise((resolve, reject) => {
    cancelPromiseReject = reject
  })

  async function makeRequestIter() {
    const response = await Promise.race([
      responsePromise,
      cancelPromise,
      timeoutPromise
    ])

    const responseIter = response[Symbol.asyncIterator]()

    const data = (async function* () {
      try {
        const chunkSize = 1024 * 1024 // 每个分块的大小，这里设置为 1MB
        let buffer = Buffer.alloc(0) // 缓存数据的 Buffer
        while (true) {
          const item = await Promise.race([
            responseIter.next(),
            cancelPromise,
            timeoutPromise
          ])
          if (item.done) {
            break
          }
          buffer = Buffer.concat([buffer, item.value]) // 将获取到的数据追加到缓存 Buffer 中
          while (buffer.length >= chunkSize) {
            const chunk = buffer.slice(0, chunkSize) // 取出一个分块
            buffer = buffer.slice(chunkSize) // 从缓存 Buffer 中移除已经取出的分块
            const md5 = crypto.createHash("md5").update(chunk).digest("hex") // 计算分块的 md5 值
            yield { buffer: chunk, md5 } // 将 buffer 和 md5 作为对象返回
          }
        }
        if (buffer.length > 0) {
          // 处理最后不足一个分块大小的数据
          const md5 = crypto.createHash("md5").update(buffer).digest("hex")
          yield { buffer, md5 }
        }
      } catch (error) {
        abort(request._currentRequest)
        throw error
      }
    })()

    let _buffer
    let _md5
    for await (const { buffer, md5 } of data) {
      _buffer = buffer
      _md5 = md5
    }

    return {
      dataStream: Readable.from(_buffer),
      md5: _md5,
      originalResponse: response // The original
    }
  }

  return {
    makeRequestIter,
    cancel() {
      const customError = new Error("Request cancelled")
      customError.code = "ERR_REQUEST_CANCELLED"
      cancelPromiseReject(customError)
    }
  }
}

module.exports = makeRequest

/**
 *
 * @param {ClientRequest} request
 */
function abort(request) {
  const majorNodeVersion = process.versions.node.split(".")[0]
  if (!majorNodeVersion || majorNodeVersion < 14) {
    request.abort()
  } else {
    request.destroy()
  }
}
