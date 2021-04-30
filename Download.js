const fs = require('fs');
const abort = require('./utils/abort')
const http = require('http')//For jsdoc
const IncomingMessage = http.IncomingMessage
const ClientRequest = http.ClientRequest
const { request: makeRequest } = require('./request');
const stream = require('stream');
var HttpsProxyAgent = require('https-proxy-agent');
const { Transform } = require('stream')
const util = require('util');
const FileProcessor = require('./utils/FileProcessor');
const pipelinePromisified = util.promisify(stream.pipeline);
const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const { deduceFileName } = require('./utils/fileName');
const RequestWrapper = require('./RequestWrapper');
const unlink = util.promisify(fs.unlink)
const rename = util.promisify(fs.rename)


module.exports = class Download {

    /**
   * 
   * @param {object} config 
   * @param {string} config.url 
   * @param {string} [config.directory]    
   * @param {string} [config.fileName = undefined] 
   * @param {boolean} [config.cloneFiles=true] 
   * @param {number} [config.timeout=6000]   
   * @param {object} [config.headers = undefined] 
   * @param {object} [config.httpsAgent = undefined] 
   * @param {string} [config.proxy = undefined]   
   * @param {function} [config.onResponse = undefined] 
   * @param {function} [config.onBeforeSave = undefined] 
   * @param {function} [config.onProgress = undefined]   
   * @param {boolean} [config.shouldBufferResponse = false] 
   * @param {boolean} [config.useSynchronousMode = false] 
   */
    constructor(config) {

        const defaultConfig = {
            directory: './',
            fileName: undefined,
            timeout: 6000,
            useSynchronousMode: false,
            httpsAgent: undefined,
            proxy: undefined,
            headers: undefined,
            cloneFiles: true,
            shouldBufferResponse: false,
            onResponse: undefined,
            onBeforeSave: undefined,
            onProgress: undefined
        }

        this.config = {
            ...defaultConfig,
            ...config
        }


        // this.wrapperReject = null;
        this.saveStreamPromise = null;

        this.isCancelled = false;
        this.percentage = 0;
        this.fileSize = null;
        this.currentDataSize = 0;
        this.responsePromise = null;
        this.response = null;//The IncomingMessage read stream.
        this.request = null;//ClientRequest 


    }




    /**
    * @return {Promise<void>}
    */
    async start() {

        // const prom = new Promise(async (resolve, reject) => {
            // this.wrapperReject = reject;
            await this._verifyDirectoryExists(this.config.directory)

            try {
                // const { response, request } = await this._request();
                await this._makeRequest();
                const {response,request} = await this._awaitResponse()
                this.response = response;
                this.request = request;
                console.log('this.response.req === this.request',this.response.req === this.request)
                debugger
                // this.request = request;

                if (this.config.onResponse) {

                    const shouldContinue = await this.config.onResponse(this.response);
                    if (shouldContinue === false) {
                        // resolve();
                        return;
                    }
                }
                debugger
                await this._save(this.response)
                debugger
                // resolve();
                debugger
            } catch (error) {
                debugger
                if (this.isCancelled) {
                    const customError = new Error('Request cancelled')
                    customError.code = 'ERR_REQUEST_CANCELLED'
                    throw customError
                }
                throw error;
            }
        // })


        // return prom;



    }

    // debugger








    async _awaitResponse() {
        // debugger
        const {response,request} = await this.responsePromise

        // debugger
        const headers = response.headers;
        // debugger
        const contentLength = headers['content-length'] || headers['Content-Length'];
        this.fileSize = parseInt(contentLength);
        return {response,request};

    }







    async _makeRequest() {
        const { timeout, headers, proxy, url, httpsAgent } = this.config;
        const options = {
            timeout,
            headers
        }
        if (httpsAgent) {
            options.httpsAgent = httpsAgent;
        }
        else if (proxy) {
            // debugger
            options.httpsAgent = new HttpsProxyAgent(proxy)
        }

        // debugger
        const wrapper = new RequestWrapper(url, options)
        this.requestWrapper = wrapper;

        const request = wrapper.makeRequest()
        this.responsePromise = wrapper.responsePromise;
        this.request = request;
        request.on('error', (e) => {
            debugger;
            console.log(e)
            // reject(new Error(e.message))
        })

        // const { response, request } = await makeRequest(url, options);
        // debugger

        // return { response, request }
    }




    /**
     * @param {IncomingMessage} response
     * @return {Promise<void>}
     */
    async _save(response) {

        try {
            // debugger
            let finalName = await this._getFinalFileName(response.headers);

            if (this.config.onBeforeSave) {
                // debugger
                const clientOverideName = await this.config.onBeforeSave(finalName)
                if (clientOverideName && typeof clientOverideName === 'string') {
                    finalName = clientOverideName;
                }
            }

            const finalPath = `${this.config.directory}/${finalName}`;

            var tempPath = this._getTempFilePath(finalPath);

            if (this.config.shouldBufferResponse) {
                const buffer = await this._createBufferFromResponseStream(response);
                await this._saveFromBuffer(buffer, tempPath);
                // await this._saveFromBuffer(buffer, finalPath);
            } else {
                await this._saveFromReadableStream(response, tempPath);
                // await this._saveFromReadableStream(response, finalPath);
            }
            // debugger;
            await this._renameTempFileToFinalName(tempPath, finalPath)

        } catch (error) {
            // debugger
            await this._removeFailedFile(tempPath)
            throw error;
        }


    }
    async _verifyDirectoryExists(directory) {
        await mkdir(directory, { recursive: true });
    }



    /**
     * 
     * @param {string} fullPath 
     * @return {Promie<WritableStream>}
     */
    _createWriteStream(fullPath) {
        // debugger
        return fs.createWriteStream(fullPath)
    }

    /**
     * 
     * @param {IncomingMessage} stream 
     * @returns 
     */
    async _createBufferFromResponseStream(stream) {
        const chunks = []
        for await (let chunk of stream) {
            chunks.push(chunk)
        }

        const buffer = Buffer.concat(chunks)
        return buffer;
    }


    _getProgressStream() {
        const that = this;
        const progress = new Transform({

            transform(chunk, encoding, callback) {

                that.currentDataSize += chunk.byteLength;
                if (that.fileSize) {
                    that.percentage = ((that.currentDataSize / that.fileSize) * 100).toFixed(2)
                } else {
                    that.percentage = NaN
                }

                const remainingFracture = (100 - that.percentage) / 100;
                const remainingSize = Math.round(remainingFracture * that.fileSize);


                if (that.config.onProgress) {
                    // debugger
                    that.config.onProgress(that.percentage, chunk, remainingSize);
                }

                // Push the data onto the readable queue.
                callback(null, chunk);
            }
        });

        return progress;

    }







    async _pipeStreams(arrayOfStreams) {
        try {
            debugger
           await pipelinePromisified(...arrayOfStreams); 
           debugger
        } catch (error) {
            debugger
            throw error;
        }
        
    }



    async _saveFromReadableStream(read, path) {
        // debugger;
        const streams = [read];
        const write = this._createWriteStream(path)
        if (this.config.onProgress) {
            const progressStream = this._getProgressStream()
            streams.push(progressStream);

        }
        streams.push(write)
        // debugger
        await this._pipeStreams(streams)
        // debugger


    }



    async _saveFromBuffer(buffer, path) {
        // debugger;
        // const tempPath = this._getTempFilePath(path);
        await writeFile(path, buffer)

    }

    async _removeFailedFile(path) {
        await unlink(path);
    }

    async _renameTempFileToFinalName(temp, final) {
        // debugger;
        await rename(temp, final)
    }

    /**
     * 
     * @param {string} finalpath 
     */
    _getTempFilePath(finalpath) {
        return `${finalpath}.download`;
    }



    /**
     * @param {object} responseHeaders 
     */
    async _getFinalFileName(responseHeaders) {
        let fileName;
        if (this.config.fileName) {
            fileName = this.config.fileName
        } else {
            fileName = deduceFileName(this.config.url, responseHeaders)
        }

        if (this.config.cloneFiles) {

            var fileProcessor = new FileProcessor({ useSynchronousMode: this.config.useSynchronousMode, fileName, path: this.config.directory })

            fileName = await fileProcessor.getAvailableFileName()
        }

        return fileName;
    }


    cancel() {
        debugger
        console.log('cancel', !this.request)
        this.isCancelled = true;
        abort(this.request)
        // this.response.emit('error', 'yoyo');
        // const customError = new Error('Request cancelled')
        // customError.code = 'ERR_REQUEST_CANCELLED'
        debugger
        // this.response.emit('error')
        // this.wrapperReject(customError)


    }
}


