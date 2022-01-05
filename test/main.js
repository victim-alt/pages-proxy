const { expect } = require('chai');
const supertest = require('supertest');

const { parseConf } = require('../bin/parse-conf');

const {
  PREVIEW_PATH_PREFIX,
  DEFAULT_PATH_PREFIX,
  PROXY_URL,
  DOMAIN,
  INCLUDE_SUBDOMAINS,
} = process.env;

supertest.Test.prototype.expectStandardHeaders = function() {
  this.expect('X-Frame-Options', 'SAMEORIGIN');
  this.expect('X-Server', 'Federalist');
  this.expect('Strict-Transport-Security', /max-age=31536000; preload/);
  return this;
}

const request = supertest(PROXY_URL);

function makeRequest(path, host, expectations = []) {
  const initial = request
    .get(path)
    .set('Host', host)
    .expectStandardHeaders();
  
  return expectations.reduce((r, expectation) => r.expect(...expectation), initial);
}

const previewPrefixPath = (path) => `/${PREVIEW_PATH_PREFIX}${path}`;
const defaultPrefixPath = (path) => `/${DEFAULT_PATH_PREFIX}${path}`;
previewPrefixPath.toString = () => 'preview path';
defaultPrefixPath.toString = () => 'default path';

const prefixPathFns = [
  previewPrefixPath,
  defaultPrefixPath
];

describe('parse-conf', () => {
  it('removes `daemon` configuration', () => {
    const template = `
      foo;
      daemon off;
      bar;
    `;
    const funcs = {};

    const result = parseConf(template, funcs);

    expect(result).to.equal(`
      foo;
      
      bar;
    `);
  });

  it('replaces interpolated functions with no arguments', () => {
    const template = `
      foo;
      listen {{port}};
      bar;
    `;
    const funcs = { port() { return 9000; } };

    const result = parseConf(template, funcs);

    expect(result).to.equal(`
      foo;
      listen 9000;
      bar;
    `);
  });

  it('replaces interpolated functions with arguments', () => {
    const value = 'BUCKET_URL'

    const template = `
      foo;
      set $bucket_url {{env "${value}"}};
      bar;
    `;
    const funcs = { env(arg) { return `http://${arg}`; } };

    const result = parseConf(template, funcs);

    expect(result).to.equal(`
      foo;
      set $bucket_url http://${value};
      bar;
    `);
  });
});

describe('robots.txt', () => {
  it('is available', () => {
    return request
      .get('/robots.txt')
      .expectStandardHeaders()
      .expect(200)
      .expect('Content-Type', /text\/plain/)
      .expect(/Disallow/);
  });
});

describe('Health check', () => {
  it('returns 200', () => {
    return request
      .get('/health')
      .expectStandardHeaders()
      .expect(200);
  });
});

describe('For `federalist-proxy-staging` hosts', () => {
  const host = 'federalist-proxy-staging.app.cloud.gov';

  for (const prefixPathFn of prefixPathFns) {
    describe(`with the ${prefixPathFn}`, () => {
      it('returns results from the SHARED bucket', () => {
        return makeRequest(prefixPathFn('/bucket.html'), host, [[200], [/shared/i]]);
      });

      describe('Paths', pathSpecs(host, prefixPathFn));
    });
  }
});

describe('For non-`federalist-proxy-staging` hosts', () => {
  const host = 'foobar.app.cloud.gov';

  for (const prefixPathFn of prefixPathFns) {
    describe(`with the ${prefixPathFn}`, () => {
      it('returns results from the DEDICATED bucket', () => {
        return makeRequest(prefixPathFn('/bucket.html'), host, [[200], [/dedicated/i]]);
      });
    
      describe('Paths', pathSpecs(host, prefixPathFn));
    });
  }
});

describe('For `includeSubdomains` specific hosts', () => {
  const subs = INCLUDE_SUBDOMAINS.split('|');
  for(const sub of subs) {
    const host = `${sub}.app.cloud.gov`;

    for (const prefixPathFn of prefixPathFns) {
      describe(`with the ${prefixPathFn}`, () => {
        it('returns results from the DEDICATED bucket', () => {
          return makeRequest(prefixPathFn('/bucket.html'), host, [[200], [/dedicated/i]]);
        });

        describe('Headers', () => {
          it('includes expected headers', () => {
            return makeRequest(prefixPathFn('/file'), host, [
              [200],
              ['Content-Type', /charset=utf-8/],
              ['Strict-Transport-Security', 'max-age=31536000; preload; includeSubDomains']
            ]);
          });

          describe('For .cfm files', () => {
            it('includes text/html content type header', () => {
              return makeRequest(prefixPathFn('/test/helloworld.cfm'), host, [
                [200],
                ['Content-Type', /text\/html/],
                ['Strict-Transport-Security', 'max-age=31536000; preload; includeSubDomains'],
              ]);
            });
          });
            
          describe('Paths', pathSpecs(host, prefixPathFn));
        });
      });
    }
  }
});

function pathSpecs(host, prefixPathFn) {
  return () => {
    describe('/<some-path>', () => {
      describe('when the file is a redirect object', () => {
        it('serves the content at the redirect location', () => {          
          return makeRequest(prefixPathFn('/redirect-object'), host, [
            [200],
            ['Content-Type', 'text/html; charset=utf-8'],
            [/redirect-object-target/i],
          ]);
        });
      });

      describe('when the file exists with a content type', () => {
        it('serves the file', () => {
          return makeRequest(prefixPathFn('/file'), host, [
            [200],
            ['Content-Type', 'text/html; charset=utf-8'],
            [/file/i],
          ]);
        });
      });

      describe('when the file exists without a content type', () => {
        it('serves the file with S3 default content type', () => {
          return makeRequest(prefixPathFn('/no-content-type'), host, [
            [200],
            ['Content-Type', 'application/octet-stream'],
          ])
            .then(matchBody(/no-content-type/i));
        });
      });

      describe('when the file does not exist', () => {
        it('serves the default 404.html', () => {
          return makeRequest(prefixPathFn('/unicorn'), host, [
            [404],
            // Should ALWAYS return the *bucket* 404
            [/default - 4044444444/i],
          ]);
        });
      })
    });

    describe('/<some-path>/', () => {
      describe('when /<some-path>/index.html exists', () => {
        it('serves /<some-path>/index.html', () => {
          return makeRequest(prefixPathFn('/file/'), host, [
            [200],
            [/file2/i],
          ]);
        });
      });

      describe('when /<some-path>/index.html does not exist', () => {
        it('serves the default 404.html', () => {
          return makeRequest(prefixPathFn('/unicorn/'), host, [
            [404],
            // Should ALWAYS return the *bucket* 404
            [/default - 4044444444/i],
          ]);
        });
      });
    });

    describe('/<some-path>/index.html', () => {
      describe('when /<some-path>/index.html exists', () => {
        it('serves /<some-path>/index.html', () => {
          return makeRequest(prefixPathFn('/file/index.html'), host, [
            [200],
            [/file2/i],
          ]);
        });
      });
    });
  };
}

function matchBody(regex) {
  return response => expect(response.body.toString()).to.match(regex);
}
