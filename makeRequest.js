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
        const hash = crypto.createHash("md5")
        while (true) {
          const item = await Promise.race([
            responseIter.next(),
            cancelPromise,
            timeoutPromise
          ])
          if (item.done) {
            break
          }
          hash.update(item.value)
          yield { buffer: item.value }
        }
        const md5 = hash.digest("hex")
        yield { md5 }
      } catch (error) {
        abort(request._currentRequest)
        throw error
      }
    })()

    const _buffer = []
    let _md5 = ""
    for await (const { buffer, md5 } of data) {
      if (buffer) {
        _buffer.push(buffer)
      } else {
        _md5 = md5
      }
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
