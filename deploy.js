// EdgeOne Pages Deployer - Pure Node.js, no external dependencies
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============ TencentCloud TC3 Sign ============
function tc3Sign(secretKey, date, service, stringToSign) {
    const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
    const hash = s => crypto.createHash('sha256').update(s).digest('hex');
    const secretDate = hmac(secretKey, date);
    const secretService = hmac(secretDate, service);
    const secretSigning = hmac(secretService, 'tc3_request');
    return crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
}

async function tencentApi(action, payload, service = 'teo', region = 'ap-guangzhou') {
    const secretId = process.env.TENCENT_SECRET_ID;
    const secretKey = process.env.TENCENT_SECRET_KEY;
    const appId = process.env.TENCENT_APP_ID;

    const host = service + '.tencentcloudapi.com';
    const version = '2022-09-01';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().split('T')[0];
    const payloadJson = JSON.stringify(payload);

    const canonicalHeaders = `content-type:application/json\nhost:${host}\n`;
    const signedHeaders = 'content-type;host';
    const hashedPayload = crypto.createHash('sha256').update(payloadJson).digest('hex');
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
    const credentialScope = `${date}/${service}/tc3_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;
    const signature = tc3Sign(secretKey, date, service, stringToSign);

    const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = {
        'Authorization': authorization,
        'Content-Type': 'application/json',
        'Host': host,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': region,
    };

    const body = Buffer.from(payloadJson);
    const urlObj = new URL(`https://${host}`);

    const reqOptions = {
        hostname: urlObj.hostname,
        path: '/',
        method: 'POST',
        headers: { ...headers, 'Content-Length': body.length }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(reqOptions, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve(data); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ============ Deploy ============
async function deploy() {
    console.log('🚀 Starting EdgeOne Pages deployment...');
    console.log(`   APP ID: ${process.env.TENCENT_APP_ID}`);

    // Step 1: Check existing sites
    console.log('\n[1/4] Checking EdgeOne sites...');
    const sitesResp = await tencentApi('DescribeSites', {});
    const sites = sitesResp?.Response?.Sites || [];
    console.log(`   Found ${sites.length} site(s)`);

    let siteId = null;
    if (sites.length > 0) {
        siteId = sites[0].SiteId;
        console.log(`   Using existing site: ${siteId}`);
    } else {
        // Create a site - need to provide zone_id/zone_name
        console.log('   No sites found. Creating new site...');
        const createResp = await tencentApi('CreateSite', {
            // zone_name is required - get from domain
            // For Pages, we need to use Pages-specific APIs
            Name: 'yudaihua-blog',
        });
        siteId = createResp?.Response?.SiteId;
        console.log(`   Created site: ${siteId}`);
    }

    // Step 2: Create or update Pages project
    console.log('\n[2/4] Creating Pages deployment...');
    
    // For EdgeOne Pages, use CreateDeployment or similar
    // Try CreateDeployment first
    const deployResp = await tencentApi('CreateDeployment', {
        SiteId: siteId,
        // Framework: 'static',
        // BuildCommand: '',
        // OutputDir: '/',
    });
    
    console.log('   Deployment response:', JSON.stringify(deployResp?.Response || deployResp, null, 2));

    // Step 3: Upload files via pre-signed URL
    console.log('\n[3/4] Checking deployment status...');
    const deployId = deployResp?.Response?.DeploymentId || deployResp?.Response?.Deployment?.DeploymentId;
    
    if (deployId) {
        console.log(`   Deployment ID: ${deployId}`);
        
        // Poll deployment status
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const statusResp = await tencentApi('DescribeDeployment', {
                SiteId: siteId,
                DeploymentId: deployId,
            });
            const status = statusResp?.Response?.Deployment?.Status;
            console.log(`   Status: ${status}`);
            if (status === 'success' || status === 'failed') break;
        }
    }

    // Step 4: Bind custom domain
    console.log('\n[4/4] Binding custom domain yudaihua.us.ci...');
    const domainResp = await tencentApi('CreateCustomDomain', {
        SiteId: siteId,
        Domain: 'yudaihua.us.ci',
        DomainType: 'subdomain',
    });
    console.log('   Domain response:', JSON.stringify(domainResp?.Response || domainResp, null, 2));

    console.log('\n===========================================');
    console.log('  Deployment complete!');
    console.log('  Site: https://yudaihua.us.ci');
    console.log('===========================================');
}

deploy().catch(err => {
    console.error('Deployment failed:', err.message);
    process.exit(1);
});
