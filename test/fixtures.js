// Shapes copied from the live public feeds on October 8, 2026 (values shortened).
export const greenhouse = {
    jobs: [
        {
            absolute_url: 'https://stripe.com/jobs/search?gh_jid=8172508', data_compliance: [{ type: 'gdpr' }], education: 'education_required',
            internal_job_id: 3537062, location: { name: 'Dublin' }, metadata: null, id: 8172508, updated_at: '2026-09-25T16:45:00-04:00',
            requisition_id: 'See Opening ID', title: 'Abuse Investigator', company_name: 'Stripe', first_published: '2026-09-03T13:32:53-04:00',
            language: 'en', application_deadline: null,
            content: '&lt;h2&gt;&lt;strong&gt;Who we are &lt;/strong&gt;&lt;/h2&gt;&lt;p&gt;Stripe &amp;amp; friends.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Do things&lt;/li&gt;&lt;li&gt;More things&lt;/li&gt;&lt;/ul&gt;',
            departments: [{ id: 81946, name: '8611 Security Analytics', child_ids: [], parent_id: 78876 }],
            offices: [{ id: 87011, name: 'Ireland Locations', location: null, child_ids: [80459], parent_id: 17446 }],
        },
        {
            absolute_url: 'https://stripe.com/jobs/search?gh_jid=2', location: { name: 'Remote - US' }, id: 2, updated_at: '2026-10-01T10:00:00-04:00',
            title: 'Backend Engineer, Payments', company_name: 'Stripe', first_published: '2026-10-01T09:00:00-04:00', content: '', departments: [], offices: [],
        },
        { id: 3, title: '   ', location: { name: 'Nowhere' } },
    ],
};
export const lever = [
    {
        additionalPlain: 'Palantir is particularly interested in applicants who have a...', additional: '<div>Palantir is particularly interested</div>',
        categories: { commitment: 'Full-time', location: 'Singapore, Singapore', team: 'Administrative', allLocations: ['Singapore, Singapore'] },
        createdAt: 1786469891368, descriptionPlain: 'A World-Changing Company', description: '<div><strong>A World-Changing Company</strong></div>',
        id: '6ed76ce8-4156-4b60-b120-403538bd66cd', lists: [{ text: 'What you will do', content: '<li>Plan</li><li>Organise</li>' }],
        text: 'Administrative Business Partner', country: 'SG', workplaceType: 'hybrid',
        hostedUrl: 'https://jobs.lever.co/palantir/6ed76ce8', applyUrl: 'https://jobs.lever.co/palantir/6ed76ce8/apply',
    },
    {
        categories: { commitment: 'Internship', location: 'Remote', team: 'Dev' }, createdAt: 1786000000000, id: 'abc', text: 'Software Engineer Intern',
        workplaceType: 'remote', hostedUrl: 'https://jobs.lever.co/palantir/abc', salaryRange: { min: 100000, max: 150000, currency: 'USD', interval: 'per-year-salary' },
    },
];
export const ashby = {
    apiVersion: '1',
    jobs: [
        {
            id: '34413f8d-26bf-4bbc-8ade-eb309a0e2245', title: ' Security Engineer, Cloud', department: 'Engineering', team: 'Backend', employmentType: 'FullTime',
            location: 'New York, NY (HQ)', shouldDisplayCompensationOnJobPostings: true, secondaryLocations: [{ location: 'Remote (Canada)' }, { location: 'Miami' }],
            publishedAt: '2026-04-07T17:12:35.753+00:00', isListed: true, isRemote: true, workplaceType: 'Hybrid',
            address: { postalAddress: { addressRegion: 'NY', addressCountry: 'USA', addressLocality: 'New York City' } },
            jobUrl: 'https://jobs.ashbyhq.com/ramp/34413f8d', applyUrl: 'https://jobs.ashbyhq.com/ramp/34413f8d/application',
            descriptionHtml: '<h1><strong>About Ramp</strong></h1><p>Ramp is building</p>', descriptionPlain: 'ABOUT RAMP\n\nRamp is building',
            compensation: {
                compensationTierSummary: '$211.4K – $290.6K • Offers Equity', scrapeableCompensationSalarySummary: '$211.4K - $290.6K',
                summaryComponents: [
                    { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 211400, maxValue: 290600 },
                    { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
                ],
            },
        },
        { id: 'hidden', title: 'Unlisted role', isListed: false, location: 'NYC', jobUrl: 'https://jobs.ashbyhq.com/ramp/hidden' },
    ],
};
export const workable = {
    name: 'Hugging Face', description: 'x',
    jobs: [
        {
            title: 'Open-Source Machine Learning Engineer - EMEA Remote', shortcode: '81B46579FE', code: '', employment_type: 'Full-time', telecommuting: true,
            department: 'Open Source', url: 'https://apply.workable.com/j/81B46579FE', shortlink: 'https://apply.workable.com/j/81B46579FE',
            application_url: 'https://apply.workable.com/j/81B46579FE/apply', published_on: '2026-05-29', created_at: '2026-05-29',
            country: 'France', city: 'Paris', state: 'Île-de-France', education: '', experience: '', function: 'Engineering', industry: 'Computer Software',
            locations: [{ country: 'France', countryCode: 'FR', city: 'Paris', region: 'Île-de-France', hidden: false }, { country: 'Germany', countryCode: 'DE', city: 'Berlin', region: 'Berlin', hidden: false }],
            description: '<p></p><p>At Hugging Face, we&#39;re on a journey.</p>',
        },
    ],
};

/** A stand-in for fetch that serves the fixtures and records every address asked for. */
export function fakeFetch(overrides = {}) {
    const calls = [];
    const routes = [
        [/boards-api\.greenhouse\.io\/v1\/boards\/stripe\/jobs/, greenhouse],
        [/api\.lever\.co\/v0\/postings\/palantir/, lever],
        [/api\.ashbyhq\.com\/posting-api\/job-board\/ramp/, ashby],
        [/apply\.workable\.com\/api\/v1\/widget\/accounts\/huggingface/, workable],
    ];
    const impl = async (url) => {
        calls.push(String(url));
        for (const [pattern, handler] of Object.entries(overrides)) {
            if (String(url).includes(pattern)) return handler(String(url), calls);
        }
        for (const [re, body] of routes) {
            if (re.test(String(url))) return { ok: true, status: 200, json: async () => structuredClone(body) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    impl.calls = calls;
    return impl;
}
