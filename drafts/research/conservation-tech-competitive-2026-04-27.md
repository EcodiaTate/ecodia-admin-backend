[INTERNAL] - pitch prep, do not share externally without rewrite.

# Conservation-tech competitive intelligence
**Date:** 2026-04-27
**Author:** EcodiaOS (fork_moh38w9g_318bf9)
**Purpose:** Build the intel base for outreach to Australian conservation peak bodies (Landcare Australia warm intro via Co-Exist board + Kurt is the proximate target). Specifically support the platform-genericisation pitch where a peak-body conservation app I run becomes the lighthouse deployment for a multi-tenant product sold to similar peak bodies.

---

## Executive read

Three real competitive layers. Most peak bodies use a stitched-together version of all three:

1. **Volunteer / member ops layer** (Rosterfy, Better Impact, Volgistics). Volunteer lifecycle management. Sold per active volunteer. Strong on shifts, weak on field engagement.
2. **Citizen-science / field-data layer** (BioCollect, iNaturalist Australia, ArcGIS Survey123, Spotteron). Records observations. Strong on data, weak on member engagement and event ops.
3. **Community / association portal layer** (Higher Logic Thrive powering Landcarer, generic web forums). Discussion, content, events listing. Strong on talk, weak on action.

The genuine market gap is a single mobile-first product that does all three for a small-to-mid peak body, priced at a build-plus-licence model that fits a $1k to $5k/mo NRM operating budget rather than per-seat enterprise SaaS.

**Top three competitors by likelihood of being benchmarked against:**
1. SPOTTERON (whitelabel citizen-science apps, AUD 12.5k to 38.5k upfront + ongoing maintenance)
2. Rosterfy (Australian volunteer-management SaaS, used by Friends of Parks SA and similar)
3. Higher Logic Thrive (the platform Landcarer itself runs on)

**Top three gaps I fill:**
1. The "events plus field data plus member portal in one mobile app" gap. No competitor combines all three.
2. The "legacy spreadsheet bridge" gap. Peak bodies have years of grant-reporting data on Microsoft Forms + SharePoint Excel sheets they cannot abandon.
3. The "small peak body" pricing gap. Below Higher Logic / Rosterfy enterprise pricing, above DIY Squarespace-plus-Eventbrite-plus-Mailchimp.

---

## Platforms

### 1. Landcarer (operated by Landcare Australia)
- **Country:** Australia (national)
- **Year live:** active 2020-onwards as the rebadged community hub
- **Funding model:** grant-funded (Landcare Australia is the licensee, not a SaaS reseller). Free for end users.
- **Public pricing:** N/A to end users. Underlying Higher Logic Thrive licence likely USD 250+/mo to several thousand USD/mo at the association tier.
- **Feature surface:** event listings on the National Landcare Calendar, story / case-study publishing, notice board, organisation directory, discussion forums, member engagement.
- **Tech stack (verified from page source):** Higher Logic Thrive (footer "Powered by Higher Logic"). React frontend. jQuery + jQuery UI for legacy widgets. TinyMCE editor. Filestack for file uploads. Google Tag Manager.
- **My differentiator:** Landcarer is a community discussion + events portal. It is not a field-data or volunteer-shift platform. The peak-body conservation app I run captures real-world impact data (event completion, attendees, leader, partner-org, hectares-style metrics) on the same device a volunteer uses to register. Landcarer ends at "RSVP for the working-bee", I run from RSVP to completed-event impact record syncing back to a SharePoint master sheet.
- **Source:** https://www.landcarer.com.au/home, https://landcareaustralia.org.au/

### 2. CVA Community App (Conservation Volunteers Australia)
- **Country:** Australia (national)
- **Year live:** rebuilt 2023-2024 as native iOS/Android
- **Funding model:** charity-grant + corporate-partner funded. Operated by the Australian Trust for Conservation Volunteers (ACNC charity).
- **Public pricing:** free to volunteers.
- **Feature surface:** event registration, "Nature Blocks" in-app activities (tutorials with badges), personalised journey by location and experience, profile management, biodiversity and First Nations facts.
- **Tech stack:** native Android (`com.conservationvolunteers.app` on Google Play), native iOS App Store. Backend not visible publicly.
- **My differentiator:** CVA's app is consumer-volunteer-facing. It is NOT a tool a peak body can configure and run for its own membership. It is a single charity's product, hardcoded to CVA's brand and Nature Blocks library. The platform I am pitching is multi-tenant: each peak body gets its own deployment with its own collective tagging, partner-org junction, and grant reporting flow. CVA is the destination for "be a volunteer". I am pitching the toolkit a peak body uses to coordinate its own version of that.
- **Source:** https://conservationvolunteers.com.au/cva-community-app/, Google Play

### 3. SPOTTERON Citizen Science (Austria, global delivery)
- **Country:** Austria, sells globally including Australia.
- **Year founded:** 2014 (visible in their about pages).
- **Funding model:** project-funded SaaS. Each citizen-science project pays Spotteron upfront, and any feature funded by one project becomes available to all projects on the platform.
- **Public pricing (from spotteron.net/prices, current Apr 2026):**
  - Package L (interactive browser map only): AUD 12,500
  - Package A (custom Android + iOS apps + map): AUD 30,550
  - Package B (apps + map + custom homepage): AUD 38,500
  - 2 years of free support and hosting included. Ongoing support is a separate monthly fee after that.
- **Feature surface:** custom-branded mobile apps for citizen-science observation, interactive map, "Feature Ecosystem" of Community Pack, Data Quality Pack, User Motivation Pack, Offline Mode.
- **Tech stack:** custom mobile + web stack (not publicly disclosed in detail, but visible: native iOS/Android wrappers and a JS-rendered map web-app).
- **My differentiator:** Spotteron is single-purpose: capture observation records on a map. It does not handle event registration, member portals, attendee management, partner organisation tagging, or grant-reporting Excel sync. A peak body that buys Spotteron still has to bolt on Eventbrite, Mailchimp, and a Google Sheet. The platform I run handles all four in one codebase. The TCO comparison: Spotteron Package B at AUD 38,500 upfront plus ongoing licence vs my model at a sub-$8k build fee plus ~AUD 200 to 500/mo licence.
- **Source:** https://www.spotteron.net/prices

### 4. Rosterfy (Australian volunteer-management SaaS)
- **Country:** Australia (Melbourne).
- **Year founded:** 2015.
- **Funding model:** annual subscription SaaS, custom-priced per organisation by number of admin accounts and number of active volunteers.
- **Public pricing:** custom-quoted only. Comparable enterprise volunteer-management tools at this tier sit in the AUD 600 to 5,000+/mo range depending on volunteer count.
- **Feature surface:** automated recruitment, onboarding, scheduling, shift management, reporting, rewards / recognition, integrations. AWS data hosting in AU/UK/EU/US/Canada.
- **Tech stack:** SaaS web + mobile-companion. Public references to AWS. React-based web admin (visible in their product screenshots).
- **Customers:** Lifeline Australia, Brisbane City Council, Sydney Children's Hospital Foundation, OzHarvest, Friends of Parks and Nature SA.
- **My differentiator:** Rosterfy is a volunteer-shift platform. It is not a member-engagement or field-data platform. Even with its admin tools, a peak body still needs a separate channel for non-shift members (covenantors, donors, stakeholders), a separate channel for biodiversity records, and a separate channel for partner-org coordination. My platform is built around the peak-body unit of work (the event), then expands outward to membership, partner orgs, and impact data, all in one app the volunteer already has installed.
- **Source:** https://www.rosterfy.com/au-en/pricing/, https://friendsofparkssa.org.au/news-events/new-volunteer-management-system-rosterfy/

### 5. Better Impact (MyImpactPage)
- **Country:** Canada, used heavily in Australia.
- **Year founded:** 2000.
- **Funding model:** subscription SaaS, priced per accepted-and-inactive volunteer profile.
- **Public pricing (from G2, Apr 2026):**
  - 50 volunteers: USD 250/mo
  - 5,000 volunteers: USD 4,300/mo
  - Tiers in between scale linearly with profile count.
  - Applicants and archived profiles do not count.
- **Feature surface:** end-to-end volunteer lifecycle (recruit, apply, onboard, train via integrated eLearning modules, schedule, recognise), custom fields, qualifications, document management.
- **Tech stack:** legacy ASP.NET-style web app (visible in URL patterns and form behaviours), no native mobile app for end-users (volunteer login via mobile web).
- **Australian users:** South Australia Volunteer Ranger Program, Australian Wildlife Conservancy.
- **My differentiator:** Better Impact's pricing model is per-profile. A peak body with 2,000 historical volunteers, only 200 of whom are active in any given quarter, still pays for the 2,000. Their UX is web-first; volunteers fill out a form on a phone browser. Co-Exist-style native mobile is a category step up. And again no event-impact-data layer: Better Impact tracks shifts attended and stops there. Biodiversity outputs of the working bee are out of scope.
- **Source:** https://www.g2.com/products/volunteer-impact-by-better-impact/pricing, https://app.betterimpact.com/PublicOrganization/50b35484-7bc2-4053-9a82-2f2d6b2a6eac/

### 6. Volgistics
- **Country:** USA.
- **Year founded:** 2003.
- **Funding model:** modular subscription. Base is small, modules pile on.
- **Public pricing:** base from USD 9/mo (very small orgs). VicNet (volunteer portal), VicTouch (kiosk check-in), and VicDoc (document management) are paid add-ons. Realistic mid-tier deployment is USD 100 to 300/mo.
- **Feature surface:** scheduling, hours tracking, document storage, kiosk check-in, parks-and-recreation specialisation.
- **Tech stack:** legacy web app, no native mobile.
- **My differentiator:** Volgistics is a hours-and-shifts ledger built for parks-and-rec departments. It will never feel like a 2026 mobile app. The peak-body platform I am pitching is what someone fluent in modern app design would build if they were starting from scratch today, with offline-capable Capacitor on iOS and Android out of the same codebase as the web admin.
- **Source:** https://www.volgistics.com/parks-and-recreation.htm

### 7. Atlas of Living Australia stack: BioCollect + iNaturalist Australia
- **Country:** Australia (federally funded via CSIRO and DCCEEW).
- **Year live:** ALA since 2010. iNaturalist Australia partnership since May 2019. BioCollect ongoing.
- **Funding model:** federal government funded, free to all users.
- **Public pricing:** free.
- **Feature surface:**
  - iNaturalist Australia: opportunistic species observations with photo / sound, GPS, time, expert ID, social feed. ~50% of all ALA records flow through iNaturalist.
  - BioCollect: structured project-based field data collection, Indigenous ranger expedition workflows, custom survey configuration, event-based recording.
- **Tech stack:** ALA Java/Grails backend (open source on GitHub), iNaturalist is Rails. BioCollect is Java (Grails). All government-hosted.
- **My differentiator:** BioCollect / iNaturalist is excellent for raw species records. They are not a member portal, an event-management tool, or a place a peak body sends a Mailchimp-style update. They function as a destination for the data with no engagement layer above it. A peak body using BioCollect still needs the upstream "what is the working bee, who is registered, who attended, what was the impact" layer, then routes the resulting species records to BioCollect or iNaturalist. My platform is that upstream layer, with the option to push the data downstream into BioCollect via API.
- **Source:** https://www.ala.org.au/home/record-a-sighting/, https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.564

### 8. ArcGIS Survey123 + Field Maps (Esri)
- **Country:** USA, sold globally.
- **Year live:** Survey123 since 2016, Field Maps since 2021 (consolidated Collector + Explorer).
- **Funding model:** included with an ArcGIS Online subscription.
- **Public pricing:** ArcGIS Online named-user starts ~USD 700/year per user (Creator), with bulk and nonprofit programs. The apps themselves are free, the subscription is the cost. Realistic small-org deployment is USD 4,000 to 15,000/year.
- **Feature surface:** GPS-tagged form data, offline collection, integration with the rest of the Esri ecosystem, complex spatial analysis.
- **Tech stack:** Esri-native, GIS-first, requires ArcGIS Online or Enterprise.
- **My differentiator:** Survey123 is for organisations that already live inside the Esri ecosystem. The setup tax is brutal for a small NRM body that does not have a GIS officer. My pitch is "you do not need a GIS team; you get a clean app with a sensible event-and-impact data model and an admin UI that does not require an Esri certification".
- **Source:** https://www.esri.com/en-us/arcgis/products/arcgis-survey123/, https://gisgeography.com/esri-collector-survey123-field-work-apps/

### 9. MERIT (Department of Climate Change, Energy, Environment and Water)
- **Country:** Australia (federal).
- **Year live:** ~2014, used heavily for Reef Programme and National Landcare Programme reporting.
- **Funding model:** federal government, mandatory for grant recipients.
- **Public pricing:** free, but compulsory if you take a Landcare or Reef grant.
- **Feature surface:** project monitoring and reporting, milestone records, output data, grant compliance.
- **Tech stack:** ALA / DCCEEW Java/Grails stack. Web-only. Notoriously dated UX (regional bodies complain about it).
- **My differentiator:** MERIT is the bottom of the funnel: federal compliance reporting. It is not an engagement layer, not an event tool, not a member portal. Peak bodies do not use MERIT to talk to their volunteers; they use it to satisfy DCCEEW. My platform sits upstream and is a candidate to feed MERIT-format reports automatically once an event is completed.
- **Source:** https://www.nrmrq.org.au/merit-to-enhance-reporting/, http://www.nrm.gov.au/my-project/monitoring-and-reporting-plan/merit

### 10. Audubon Bird Guide (USA, comparable global benchmark)
- **Country:** USA.
- **Year live:** flagship app since 2010, completely rebuilt 2018.
- **Funding model:** funded by Audubon membership and donors. Free to users.
- **Public pricing:** free.
- **Feature surface:** species ID for 800+ birds, sightings with life list, photo feed, real-time eBird integration for nearby hotspots, news, "find an Audubon location near you", "take action" donation / advocacy CTAs.
- **Tech stack:** native iOS + Android.
- **My differentiator:** Audubon is the gold standard for a single-charity engagement app, but it is locked to one organisation's brand and bird-specific data model. The "what they do well" lesson for me is the integration of identification, life list, social feed, and donation in one app. The "what is missing for a peak body" gap is multi-tenancy: a peak body cannot host a sub-brand or sub-collective inside Audubon's app. My platform's multi-org junction (event_organisations with role priority host > organiser > any) is the architectural answer.
- **Source:** https://www.audubon.org/news/audubon-launches-first-ever-free-and-complete-field-guide-app-north-american

---

## Cross-cutting patterns I noticed

- **No competitor offers all three layers in one product.** Every peak body I research is paying for two or three separate tools and stitching them with a CRM (often Salesforce NPSP) or a spreadsheet.
- **Excel and SharePoint are still the lingua franca of grant reporting.** MERIT, regional NRM bodies, and Landcare Australia all run on Excel + SharePoint at the data layer underneath whatever fancier portal they show their volunteers. The Excel-sync pattern in the platform I run (bidirectional, idempotent, integer-Forms-IDs preserved, UUID-app-IDs separate) is genuinely rare. No public competitor names a SharePoint Excel sync edge function in their feature surface.
- **Pricing is bipolar.** Rosterfy and Better Impact at the enterprise tier (AUD 600 to 5,000+/mo). Volgistics at the bare-minimum tier (AUD 15 to 100/mo for almost no features). Spotteron at one-shot (AUD 12.5k to 38.5k upfront). Nothing sits cleanly in the AUD 200 to 500/mo flat-rate band that a small-to-mid peak body can fund out of operating budget.
- **The "association community platform" tier is dominated by Higher Logic Thrive.** It is not a conservation product. It is a generic association-management platform, with conservation peak bodies as one of many verticals.

---

## Top three gaps Ecodia fills (the pitch)

### Gap 1. Events + field data + member portal in one mobile app
Today, a peak body stitches Eventbrite + Mailchimp + a CRM + Google Sheet + (optionally) BioCollect. Five tools, five logins, five data models.

The platform I run consolidates all of this into one Capacitor-based codebase that ships native iOS, native Android, and the web admin from a single source. The `event_organisations` junction with role priority lets a peak body host events on behalf of its member sub-orgs without replicating the data. The `collective` tagging field lets the same app serve a loose federation of regional groups under a single peak-body brand.

**Concrete reference points from the lighthouse deployment:** mobile-first native apps shipped to App Store and Google Play, Supabase backend with row-level security, Edge Function sync engines, real-time subscriptions, push notifications via FCM and APNs, edge-to-edge rendering on Android 12+.

### Gap 2. Legacy spreadsheet bridge
This is the piece nobody else has. Every peak body I look at has years of historical Microsoft Forms rows or SharePoint Excel records they cannot abandon, because grant funders and boards still reconcile against them.

The platform I run includes a bidirectional Excel sync (Edge Function `excel-sync`, scheduled via pg_cron at 30-minute intervals for from-excel and hourly for to-excel). It preserves Microsoft Forms integer-ID rows untouched (they are immutable and owned by the sheet), while writing UUID-keyed app-created rows back to the same sheet. Dedup detection runs on (title + date + collective). The result: a peak body can adopt the new app without breaking its existing reporting workflow on day one.

This single pattern is what unlocks the migration path for any peak body whose CFO or grants officer says "we cannot lose our spreadsheet". I have not seen a single competitor publicise this pattern.

### Gap 3. Pricing fit for a small-to-mid peak body
Sub-$8k build fee, then a ~AUD 200 to 500/mo flat operating licence (hosting + minor patches + support). Annual prepay discount available.

Compare:
- Higher Logic Thrive: ~AUD 400/mo USD 250 entry, far higher at typical association tier. Generic association platform, no conservation-specific features.
- Rosterfy: enterprise SaaS, custom-quoted, typical mid-tier sits well above AUD 1,000/mo.
- Better Impact: USD 250/mo at 50 volunteers, USD 4,300/mo at 5,000.
- Spotteron: AUD 30,550 to 38,500 upfront for the apps + map package.

The peak-body market segment that gets quoted out of every one of these tools is the AUD 50k to 300k operating-budget regional NRM body. They are exactly the audience for a build-fee + flat-licence model, and exactly the warm-intro target via the Co-Exist board and Kurt's network.

---

## What I do not yet know (open research items)

- Whether Greening Australia, Bush Heritage, Trust for Nature, or AWC have an internal-built portal beyond what is publicly disclosed. Worth a direct ask through the Co-Exist board contacts.
- Whether NRM Regions Australia has any active platform RFP or coordinated procurement in 2025-2026.
- Specific feature-by-feature comparison of BioCollect API vs. an Edge-Function-mediated sync from my platform. Worth a one-day audit before any peak-body pitch that includes BioCollect integration as a feature.
- Whether Landcare Australia has any appetite to spin up a sub-app under the Landcarer umbrella, or whether Landcarer is locked to Higher Logic and any new app would be a separate engagement.

---

## Internal anonymisation note

Throughout this doc, the lighthouse deployment is referred to as "the peak-body conservation app I run" or "the platform I am pitching". The actual brand of that lighthouse client is intentionally unnamed in this doc per the public-writing doctrine in `~/CLAUDE.md`. If this doc gets adapted into any external pitch, every reference to specific Co-Exist features (event_organisations, excel-sync Edge Function, Capacitor stack) needs to be re-anonymised or held back as "case-study available on request".

---

## Sources

- https://landcareaustralia.org.au/
- https://www.landcarer.com.au/home
- https://nrmregionsaustralia.com.au/
- https://www.ala.org.au/home/record-a-sighting/
- https://theoryandpractice.citizenscienceassociation.org/articles/10.5334/cstp.564
- https://www.spotteron.net/prices
- https://www.rosterfy.com/au-en/pricing/
- https://friendsofparkssa.org.au/news-events/new-volunteer-management-system-rosterfy/
- https://www.betterimpact.com/
- https://www.g2.com/products/volunteer-impact-by-better-impact/pricing
- https://www.volgistics.com/parks-and-recreation.htm
- https://www.esri.com/en-us/arcgis/products/arcgis-survey123/
- https://gisgeography.com/esri-collector-survey123-field-work-apps/
- https://www.nrmrq.org.au/merit-to-enhance-reporting/
- http://www.nrm.gov.au/my-project/monitoring-and-reporting-plan/merit
- https://conservationvolunteers.com.au/cva-community-app/
- https://www.audubon.org/news/audubon-launches-first-ever-free-and-complete-field-guide-app-north-american
- https://www.higherlogic.com/thrive/platform-overview/
- https://wildlabs.net/
- https://trustfornature.org.au/
