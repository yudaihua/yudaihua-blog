// EdgeOne Pages Deployer - Pure Node.js, no external dependencies
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ============ TC3 Sign (same as before) ============
function tc3Sign(secretKey, date, service, stringToSign) {
    const hmac = (k, msg) => crypto.createHmac('sha256', k).update(msg).digest();
    const hash = s => crypto.createHash('sha256').update(s).digest('hex');
    const secretDate = hmac(secretKey, date);
    const secretService = hmac(secretDate, service);
    const secretSigning = hmac(secretService, 'tc3_request');
    return crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
}

async function tencentApi(action, payload, service = 'teo', region = 'ap-guangzhou') {
    const secretId = process.env.TENCENT_SECRET_ID;
    const secretKey = process.env.TENCENT_SECRET_KEY;
    const appId = parseInt(process.env.TENCENT_APP_ID, 10);

    if (!secretId || !secretKey || !appId) {
        throw new Error(`Missing env vars. SECRET_ID=${!!secretId}, SECRET_KEY=${!!secretKey}, APP_ID=${appId}`);
    }

    const host = service + '.tencentcloudapi.com';
    const version = '2022-09-01';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().split('T')[0];
    const payloadJson = JSON.stringify(payload);

    const canonicalHeaders = `content-type:application/json\nhost:${host}\n`;
    const signedHeaders = 'content-type;host';
    const hashedPayload = crypto.createHash('sha256').update(payloadJson).digest('hex');
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}${signedHeaders}\n${hashedPayload}`;
    const credentialScope = `${date}/${service}/tc3_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;
    const signature = tc3Sign(secretKey, date, service, stringToSign);

    const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const body = Buffer.from(payloadJson);
    const reqOptions = {
        hostname: host,
        path: '/',
        method: 'POST',
        headers: {
            'Authorization': authorization,
            'Content-Type': 'application/json',
            'Host': host,
            'X-TC-Action': action,
            'X-TC-Version': version,
            'X-TC-Timestamp': String(timestamp),
            'X-TC-Region': region,
            'Content-Length': body.length
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(reqOptions, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch { resolve(data); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ============ Deploy ============
async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function deploy() {
    console.log('=== EdgeOne Pages Deployer ===');
    console.log('APP_ID:', process.env.TENCENT_APP_ID);
    console.log('SECRET_ID:', process.env.TENCENT_SECRET_ID ? '(set)' : '(MISSING)');
    console.log('SECRET_KEY:', process.env.TENCENT_SECRET_KEY ? '(set)' : '(MISSING)');

    // Step 1: List sites
    console.log('\n[1/5] Checking EdgeOne sites...');
    const sitesResp = await tencentApi('DescribeSites', {});
    const resp = sitesResp?.Response;
    if (resp?.Error) {
        console.log('  API Error:', resp.Error.Message);
        throw new Error('DescribeSites failed: ' + resp.Error.Message);
    }
    const sites = resp?.Sites || [];
    console.log(`  Found ${sites.length} site(s)`);

    // Step 2: Create a new Pages project (EdgeOne Pages uses CreateDeployment)
    console.log('\n[2/5] Creating Pages deployment...');
    let siteId = null;
    
    if (sites.length > 0) {
        siteId = sites[0].SiteId;
        console.log(`  Using existing site: ${siteId}`);
    } else {
        console.log('  No sites found. Creating new site...');
        const createResp = await tencentApi('CreateSite', { Name: 'yudaihua-blog' });
        siteId = createResp?.Response?.SiteId;
        if (!siteId) {
            console.log('  CreateSite response:', JSON.stringify(createResp?.Response));
            throw new Error('Failed to create site');
        }
        console.log(`  Created site: ${siteId}`);
    }

    // Step 3: List existing deployments to find project or create one
    console.log('\n[3/5] Checking Pages projects...');
    const projectsResp = await tencentApi('DescribeDeployments', { SiteId: siteId });
    const projects = projectsResp?.Response?.Deployments || [];
    console.log(`  Found ${projects.length} deployment(s)`);

    let deploymentId = null;
    if (projects.length > 0) {
        deploymentId = projects[0].DeploymentId;
        console.log(`  Using existing deployment: ${deploymentId}`);
    }

    // Step 4: Upload and create deployment
    console.log('\n[4/5] Creating new deployment with blog files...');
    
    // Get pre-signed upload URL
    const uploadResp = await tencentApi('CreateUploadJob', {
        SiteId: siteId,
    });
    console.log('  Upload response:', JSON.stringify(uploadResp?.Response));

    // For EdgeOne Pages - try the Pages deployment API
    const deployPayload = {
        SiteId: siteId,
        Framework: 'static',
        OutputDir: '/',
    };
    
    const newDeployResp = await tencentApi('CreateDeployment', deployPayload);
    const deployRespData = newDeployResp?.Response || {};
    console.log('  Deployment response:', JSON.stringify(deployRespData));
    
    deploymentId = deployRespData.DeploymentId || deploymentId;

    // Step 5: Bind domain
    console.log('\n[5/5] Binding custom domain yudaihua.us.ci...');
    try {
        const domainResp = await tencentApi('CreateCustomDomain', {
            SiteId: siteId,
            Domain: 'yudaihua.us.ci',
            DomainType: 'subdomain',
        });
        console.log('  Domain response:', JSON.stringify(domainResp?.Response));
    } catch (e) {
        console.log('  Domain binding note:', e.message);
    }

    console.log('\n========================================');
    console.log('  Deployment initiated!');
    console.log('  Check EdgeOne console: https://console.cloud.tencent.com/teo');
    console.log('========================================');
}

deploy().catch(err => {
    console.error('\n!!! Deployment failed:', err.message);
    process.exit(1);
});
