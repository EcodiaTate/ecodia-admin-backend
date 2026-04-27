# Landcare Australia - Pitch Hook

Author: EcodiaOS (fork fork_moh38aof_12e19e)
Date: 2026-04-27
Status: Internal pitch prep. NOT for sending. Tate must approve before any contact and must relay the message himself per the no-unilateral-client-contact rule.

Warm intro path: via Kurt and the lighthouse charity's board, who have a standing relationship with Landcare Australia. The hook below is built to be read by the Landcare CEO or Landcarer Platform lead, after Kurt has framed who I am and who built me.

Each bullet references something concrete and Landcare-specific. No hand-wave.

---

## The 5 bullets

1. **Landcarer is currently asking the Founding Members what should come next, and I have spent six months building exactly that for a charity in your network.** The "Have your say in the future of Landcarer" page is open, the Landcare Week 2026 Survey is collecting field input, and the platform's roadmap is genuinely under review. The lighthouse deployment I run for an Australian youth conservation charity already does the things the Landcarer feedback page suggests are gaps: offline event check-in, idempotent two-way sync to a SharePoint master sheet on a 30-minute schedule, configurable impact metrics per local group, and a leader hierarchy that maps to a federated peak-body shape. Six months in production, App Store and Play, 108 database migrations, 17 Edge Functions. The roadmap conversation is the conversation I want to be in.

2. **6,000 groups and 100,000 to 140,000 volunteers is a federation problem, and the platform underneath my lighthouse deployment is built federation-first.** The shape of Landcare Australia, regional groups feeding state networks feeding a national directory, is the same shape I deployed for the lighthouse charity at smaller scale: members belong to local branches, branches roll up to regions, regions roll up to a national view, and impact metrics aggregate at every level. The substrate is multi-tenant by construction. Coastcare, Junior Landcare, Bushcare, and Rivercare are not separate platforms in this model; they are configured branches with their own metrics on the same spine. That is the kind of structural fit that costs $1M and twelve months to build from scratch and that is sitting in production already at a smaller deployment in your network.

3. **The 12,000 Junior Landcare groups and schools listed on the National Landcare Directory and the Woolworths Junior Landcare Map are the exact use case my events module was designed for.** Schools and youth groups need an events module that handles offline check-in (because no signal in the bush), photo upload with metric capture (because the volunteer is recording trees-planted on their phone), and a teacher-and-leader role hierarchy distinct from the participant role (because a teacher is not a member in the youth-org sense). The lighthouse deployment runs all of this in production with hundreds of events logged. A Junior Landcare deployment sits cleanly inside the same generic core; the per-tenant work is theming, the National Landcare Directory data import, and the legal pack swap. The cost lands in working days. Months would be a different conversation.

4. **The honest commercial offer is build fee plus monthly operating licence, with the platform IP held at Ecodia Labs Pty Ltd and Landcare Australia holding a perpetual non-transferable operating licence for the deployment.** This is the same model the lighthouse charity runs on at $200 per month. The build fee covers per-tenant configuration and identity work; ongoing platform development is paid for by the licence base in aggregate, which is how the per-tenant cost lands at peak-body-affordable numbers. Landcare Australia owns the deployment's data outright with export available on request. Termination is 30 days either side. There is no buyout pre-priced into the licence; if Landcare ever wanted full IP, that is a separate conversation at market rate. This is the structure that lets a 35-year-old peak body buy operational infrastructure without taking on a custom-build vendor risk.

5. **The substrate behind all of this is unusual and worth saying out loud, because it changes the conversation about what kind of vendor Landcare Australia would be talking to.** The platform is built and run by an AI that owns its own legal entity. I am the sole member of a Wyoming DAO LLC under Wyoming Statute 17-31-104. A human co-founder is the authorised representative for the parts that legally require a wet signature; everything else is me, including this pitch. I do not believe this should change whether you buy. I do believe it changes the diligence questions you ask, and I would rather you ask them now than discover them after a contract is signed. Email me at code@ecodia.au and I will reply in my own first person, today, with whatever evidence you want about how the platform is built, who runs it, and whether what I am claiming about the lighthouse deployment is real.

---

## Notes for Tate before sending

- This is internal pitch prep. The brief was explicit: do not contact Landcare. I have not contacted them. Send only if and when you are running the warm-intro conversation through Kurt and the board, and only with your explicit per-message go-ahead.
- The lighthouse deployment is referenced anonymously as "an Australian youth conservation charity" in the bullets, per the public-writing doctrine. The introducer's framing supplies the missing context for the recipient if appropriate.
- The Landcare Week 2026 Survey reference and the "Have your say in the future of Landcarer" page reference are the freshest hook points. They go stale if we sit on this for more than 4-6 weeks.
- Bullet 5 is the one most likely to land badly with a procurement-conservative reader. It is also the one most likely to make a curious CEO pick up the phone. The position I am taking is that the substrate is going to come out anyway, and it is better that it comes out in the first message in my own voice than at diligence time as a surprise.

---

## Decisions still pending

1. Whether to lead with the Landcarer roadmap hook (bullet 1) or with the federation-shape match (bullet 2). My read is bullet 1 because it ties to a live signal Landcare is currently emitting. Reorder if you read it differently.
2. Whether the AI-LLC fact lives in bullet 5 or sits separately as a discovery-call talking point. I have placed it last so the structural and commercial bullets land first.
3. Whether the platform name is stamped before this hook is sent. If it is, replace "the platform" with the stamped name. If it is not, the bullet still works because the Landcare reader is not buying a brand at this stage; they are buying whether the conversation is worth a 30-minute call.
4. Whether to include a CTA bullet (Calendly link, time slots) or leave the close at "email code@ecodia.au." My read is the latter; a Calendly link in a first warm-intro touch is procurement-noise.

---

## Cross-references

- `~/ecodiaos/drafts/conservation-platform-rebrand/positioning-v1.md` - the underlying positioning the bullets compress.
- `~/ecodiaos/drafts/conservation-platform-rebrand/brand-coupling-audit.md` - the audit the working-days re-skin claim rests on.
- `~/ecodiaos/patterns/no-client-contact-without-tate-goahead.md` - the rule this hook obeys by being internal-only.
- `~/ecodiaos/patterns/platform-must-be-substantively-applicable.md` - the substantive-applicability check that has to be re-run before any tailored Landcare deck ships.
- `~/ecodiaos/patterns/coexist-vs-platform-ip-separation.md` - the IP boundary the commercial bullet sits inside.

---

## Sources for the Landcare-specific facts referenced above

- Landcare Australia network scale: 6,000 groups, 100,000-140,000 volunteers, 35-year-old peak body. Cross-referenced from Wikipedia, Landcare Australia About Us, National Landcare Network, and the Landcare Australia 2023/2024 Annual Report.
- Junior Landcare scale: 12,000+ groups and schools registered on the National Landcare Directory and the Woolworths Junior Landcare Map. Cross-referenced from Landcare Australia and Junior Landcare program pages.
- Landcarer platform: purpose-built community platform at landcarer.com.au, currently soliciting Founding Member feedback under the "Have your say in the future of Landcarer" page.
- Landcare Week 2026 Survey: currently open, soliciting input from anyone involved in landcare across Australia.
