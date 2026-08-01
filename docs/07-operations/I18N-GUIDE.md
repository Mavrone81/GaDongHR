# GaDongHR — Internationalisation Guide & HR Glossary (th / en / zh-CN)

| Field | Value |
|---|---|
| Version | 0.1 (Draft) · Date 2026-08-02 · Stage 5 |
| Locales | th-TH (default), en, zh-CN (Simplified) |
| Related | PRD §7.2 · ADR-008 · XC-I18N test suite |

## 1. Engineering Rules

1. **No hard-coded user-visible strings** — everything through i18n keys served by `svc-i18n` (namespaced per module: `leave.request.submit`). Missing key ⇒ English fallback + logged warning (XC-I18N asserts zero in release).
2. **Dates**: store ISO-8601 Gregorian (UTC) always. Render per locale: th shows Buddhist Era (พ.ศ. = ค.ศ.+543, e.g. 2 ส.ค. 2569), en/zh show Gregorian. Thai date **inputs** accept both eras — parser heuristics: year > 2400 ⇒ B.E. Never store B.E.
3. **Numbers/currency**: THB with locale grouping (฿1,234.56 / 1,234.56 บาท); satang precision in payroll; no rounding in engines, only at render.
4. **Names**: separate given/family fields per script (th/en/zh columns); display order th & en = given–family, zh = family-given (household display rule configurable); collation: Thai sort via ICU th, zh via pinyin.
5. **Addresses**: Thai structure sub-district (ตำบล/แขวง) → district (อำเภอ/เขต) → province → postcode; free-form line for en/zh mirror.
6. **Fonts/PDF**: embed Sarabun (Thai, official-document friendly) + Noto Sans SC (CJK) + Noto Sans (Latin) in svc-docs; test glyph coverage in CI (payslip snapshot in all three).
7. **Layout**: all LTR; Thai line-breaking needs dictionary-based wrap (use ICU/`Intl.Segmenter`), avoid CSS `word-break: break-all` on Thai.
8. **Notifications & documents** follow the *recipient's* preferred language; statutory export files follow the authority's required format/language regardless of user locale.
9. **Translation workflow**: en is the source language; th/zh maintained in `i18n/` bundles with review status per key; machine-translation drafts allowed but keys ship only after native review; personal data never sent to external translation APIs (PDPA doc §8).

## 2. Core HR Glossary (seed — requires native HR reviewer sign-off before release)

| en | th | zh-CN |
|---|---|---|
| Employee | พนักงาน | 员工 |
| Employer | นายจ้าง | 雇主 |
| Probation | ทดลองงาน | 试用期 |
| Onboarding | การเริ่มงาน/ปฐมนิเทศ | 入职 |
| Shift | กะการทำงาน | 班次 |
| Roster / schedule | ตารางกะ | 排班表 |
| Attendance / clock-in | การลงเวลา | 考勤 / 打卡 |
| Timesheet | ใบลงเวลาทำงาน | 考勤表 |
| Overtime (OT) | ค่าล่วงเวลา / โอที | 加班 / 加班费 |
| Public holiday | วันหยุดนักขัตฤกษ์ | 法定假日 |
| Weekly rest day | วันหยุดประจำสัปดาห์ | 每周休息日 |
| Annual leave | วันหยุดพักผ่อนประจำปี (ลาพักร้อน) | 年假 |
| Sick leave | ลาป่วย | 病假 |
| Personal/business leave | ลากิจ | 事假 |
| Maternity leave | ลาคลอด | 产假 |
| Paternity leave | ลาช่วยเหลือภริยาที่คลอดบุตร | 陪产假 |
| Infant-care leave | ลาเลี้ยงดูบุตร | 育儿假 |
| Leave balance | วันลาคงเหลือ | 假期余额 |
| Expense claim | การเบิกค่าใช้จ่าย | 费用报销 |
| Per diem | เบี้ยเลี้ยง | 出差补贴 |
| Payroll | การจ่ายเงินเดือน | 薪资核算 |
| Salary / wage | เงินเดือน / ค่าจ้าง | 工资 |
| Payslip | สลิปเงินเดือน | 工资条 |
| Deduction | รายการหัก | 扣款项 |
| Withholding tax | ภาษีหัก ณ ที่จ่าย | 预扣税 |
| Social Security Fund | กองทุนประกันสังคม | 社会保险基金 |
| Employee Welfare Fund | กองทุนสงเคราะห์ลูกจ้าง | 雇员福利基金 |
| Provident fund | กองทุนสำรองเลี้ยงชีพ | 公积金 |
| Severance pay | ค่าชดเชย | 遣散费/解雇补偿 |
| Pay in lieu of notice | ค่าบอกกล่าวล่วงหน้า | 代通知金 |
| Consent | ความยินยอม | 同意书 |
| Personal data | ข้อมูลส่วนบุคคล | 个人数据 |
| Facial recognition | การจดจำใบหน้า | 人脸识别 |

Statutory form names (สปส.1-10, ภ.ง.ด.1, 50 ทวิ, กร.11) are **not translated** in exports — shown with explanatory tooltip text per locale in the UI.

## 3. QA
XC-I18N suite: full-screen sweeps per locale, PDF pixel checks (th payslip พ.ศ. date, zh payslip CJK), pseudo-locale build to catch concatenation, and a glossary-consistency linter (same source key must not map to two different th/zh terms).
