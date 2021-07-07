import https from 'https';
import crypto from 'crypto';
import { URLSearchParams } from 'url';
import { IncomingMessage } from 'http';
import { RapydError } from './RapydError';

export class RapydClient {
  public constructor(
    private secretKey: string,
    private accessKey: string,
    private baseUrl: string = 'sandboxapi.rapyd.net',
  ) { }

  public get(path: string, ...pathValues: (string | number | boolean)[]) {
    return this.shorthandRequest('GET', path, ...pathValues);
  }

  public post(path: string, ...pathValuesAndBody: (string | number | boolean | object)[]) {
    return this.shorthandRequest('POST', path, ...pathValuesAndBody);
  }

  public put(path: string, ...pathValuesAndBody: (string | number | boolean | object)[]) {
    return this.shorthandRequest('PUT', path, ...pathValuesAndBody);
  }

  public patch(path: string, ...pathValuesAndBody: (string | number | boolean | object)[]) {
    return this.shorthandRequest('PATCH', path, ...pathValuesAndBody);
  }

  public delete(path: string, ...pathValuesAndBody: (string | number | boolean | object)[]) {
    return this.shorthandRequest('DELETE', path, ...pathValuesAndBody);
  }

  private shorthandRequest(method: string, path: string, ...pathValuesAndBody: (string | number | boolean | object)[]) {
    if (path.includes('{}')) {
      path = path.replace(/\{\}/g, () => {
        const value = pathValuesAndBody.shift();
        return encodeURIComponent(`${value}`);
      });
    }
    return this.request(method, path, pathValuesAndBody[0] as object | undefined);
  }

  public request(method: string, path: string, body?: object) {
    const salt = crypto.randomBytes(8).toString('hex');
    const timestamp = Math.round(new Date().getTime() / 1000);
    const serializedBody = this.getSerializedBody(body);
    const signature = this.getRequestSignature(method, path, serializedBody, salt, timestamp);
    const idempotency = new Date().getTime().toString();
    return this.sendRequest(method, path, serializedBody, salt, timestamp, signature, idempotency);
  }

  public queryParams(params: { [key: string]: any }): string {
    if (Object.keys(params).length) {
      return '?' + new URLSearchParams(params).toString();
    }
    return '';
  }

  private getSerializedBody(body: object | undefined) {
    const serializedBody = body ? JSON.stringify(body) : '';
    return serializedBody === '{}' ? '' : serializedBody;
  }

  private createResponse(res: IncomingMessage) {
    const contentType = getHeader('Content-Type');
    let body: Promise<Buffer> | undefined;

    let err: Error;
    res.on('error', (e) => (err = e));

    return {
      statusCode: res.statusCode,
      contentType,
      getHeader,
      stream,
      buffer,
      text,
      json,
      error,
      data,
    };

    function getHeader(name: string) {
      const headers = res.headers[name.toLowerCase()];
      if (!headers) {
        return undefined;
      }
      if (typeof headers === 'string') {
        return headers;
      }
      return headers[0];
    }

    function stream(): AsyncIterable<Buffer> {
      return res;
    }

    async function buffer() {
      if (!body) {
        body = (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of stream()) {
            chunks.push(chunk);
          }
          return Buffer.concat(chunks);
        })();
      }
      return body;
    }

    async function text() {
      const buf = await buffer();
      return buf.toString('utf-8');
    }

    async function json() {
      if (!contentType?.startsWith('application/json')) {
        throw new Error('Response is not valid JSON.');
      }
      const txt = await text();
      return JSON.parse(txt);
    }

    async function error<E>() {
      const { status } = await json();
      if (status.status === 'ERROR') {
        return new RapydError<E>(status.message, status.error_code, status.operation_id);
      }
    }

    async function data<R, E>() {
      const err = await error<E>();
      if (err) {
        throw err;
      }
      const { data } = await json();
      return data as R;
    }
  }

  private sendRequest(method: string, path: string, serializedBody: string, salt: string, timestamp: number, signature: string, idempotency: string): Promise<ReturnType<RapydClient['createResponse']>> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        port: 443,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'salt': salt,
          'timestamp': timestamp,
          'signature': signature,
          'access_key': this.accessKey,
          'idempotency': idempotency,
        },
      };

      try {
        const req = https.request(options, async (res) => {
          resolve(this.createResponse(res));
        });

        req.on('error', (err) => reject(err));
        req.end(serializedBody);
      } catch (err) {
        reject(err);
      }
    });
  }

  private getRequestSignature(method: string, path: string, serializedBody: string, salt: string, timestamp: number) {
    return (
      Buffer.from(
        crypto.createHmac('sha256', this.secretKey)
          .update(method.toLowerCase())
          .update(path)
          .update(salt)
          .update(`${timestamp}`)
          .update(this.accessKey)
          .update(this.secretKey)
          .update(serializedBody)
          .digest('hex')
      ).toString('base64')
    );
  }

  public getWebhookSignature(webhookUrl: string, saltHeader: string, timestampHeader: string, rawBody: string) {
    return (
      Buffer.from(
        crypto.createHmac('sha256', this.secretKey)
          .update(webhookUrl)
          .update(saltHeader)
          .update(timestampHeader)
          .update(this.accessKey)
          .update(this.secretKey)
          .update(rawBody)
          .digest('hex')
      ).toString('base64')
    );
  }
}
