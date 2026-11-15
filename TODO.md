# AstroNot — görüləcək işlər

## İndi

- [x] **Observation Search → FITS Viewer keçidini sadələşdir.** İstifadəçi axtarış nəticəsindən bir SPHEREx müşahidəsinin FITS faylını əldə edib görüntüləyicidə aça bilsin. Bir real nümunə ilə bu yolu əvvəldən sona yoxla.
- [x] **Sky Explorer-in ilk işlək versiyasını qur.** Bir real SPHEREx görüntüsünü aç, yaxınlaşdırma və görüntü üzərində gəzmə imkanı ver. Görüntünün koordinat məlumatından RA/Dec və baxış sahəsini göstər.
- [x] Əsas alətləri telefonda və klaviatura ilə yoxla. Boş axtarış nəticəsi, açılmayan fayl və məlumat yüklənən zaman göstərilən mətnlər aydın olsun.

## İlk demo üçün

- [x] Learn bölməsinə real nümunə ilə qısa FITS təlimatı əlavə et və onu Observation Search ilə FITS Viewer-ə bağla.
- [ ] About bölməsində komanda profillərini hazır məlumatlarla tamamla.
  - Profil UI-ı hazırdır (`about/team.js`, `about/team.css`); `about/team-data.js` hələ boşdur və səhifə **Team profiles are coming soon** göstərir. Təsdiqlənmiş ad, rol, bio və foto/link icazəsi gözlənilir, məlumat gələndən sonra bu iş bağlanacaq.
- [ ] Saytı paylaşmaq üçün önizləmə linki hazırla. Ana səhifə → **Show All** → Tools → iş sahəsi yolunu həmin linkdə yoxla.
  - Paket hazırdır və lokal yoxlanıb (`node scripts/build-demo.mjs`, `/` və `/AstroNot/` altında Chrome ilə; bax: README → Demo package). Paylaşılan HTTPS linki yoxdur: hədəf (məsələn GitHub Pages `gh-pages` branch-i və ya Actions), URL yolu, görünmə (public/private) və push/yayım icazəsi istifadəçidən gözlənilir.

## Sonrakı alətlər

- [x] **Time Machine** — eyni göy sahəsinin müxtəlif tarixlərdə çəkilmiş görüntülərini yan-yana müqayisə et.
  - [x] **Göy mövqeyi rejimi** (15 noyabr 2026): RA/Dec ilə arxivdə axtarış, bir detektorun kadrları tarix sırası ilə, hər səhifədə 6 kadr, karusel (Əvvəlki/Sonrakı), sürgü və **Oynat**. Piksellər S3-dən Range sorğuları ilə (kadr başına ~1 MB) oxunur və vahid şimal-yuxarı şəbəkəyə yenidən nümunələnir; **Bir dalğa uzunluğunu saxla** LVF səbəbindən yaranan yalançı parlaqlıq dəyişikliklərinin qarşısını alır. Axtarış üçün saytın yeganə server marşrutu `/api/sia` (`functions/api/sia.js`, Cloudflare Pages Function) əlavə olunub; o olmayan hostinqdə IRSA keçidi + CSV idxalı işləyir. Bax: README → Time Machine.
  - [ ] Cloudflare Pages-də `functions/api/sia.js`-in həqiqətən yerləşdiyini yoxla: yayımdan sonra `https://<sayt>/api/sia?collection=spherex_dr1&ra=83.8221&dec=-5.3911&detector=2` CSV qaytarmalı, `collection=x` isə 400. (`dist/` paketinə daxil deyil; Git inteqrasiyası və ya repo kökündən `wrangler pages deploy dist` lazımdır.)
  - [ ] Yeni rejimin tr/ru/es/zh sətirləri (hazırda yalnız az var); vaxt qısaltmaları (`d`, `h`, `min`) heç bir dildə tərcümə olunmur.
  - [ ] S3 əlçatmaz olanda `createHttpSource` hər sorğunu 7 dəfə təkrar edir (Məcburi Spektrofotometriyadakı eyni problem, aşağıya bax): kadr ~47 s "yüklənir" görünür. Həmin düzəliş (AbortSignal, 4xx-i təkrar etməmək, vaxt limiti) Zaman Maşınına da tətbiq olunmalıdır.
  - [ ] Dərin sahələrdə hədəf tez-tez detektorun zolaq kənarına düşür (məs. şimal ekliptik qütbü, detektor 1, ~1.09 µm): görüntüdə qaranlıq qövs (izo-dalğa uzunluğu xətti) görünür. İstinad dalğa uzunluğu zolaq daxilində seçilir, lakin qövs sahəyə düşə bilər; istifadəçiyə bunu izah edən qeyd əlavə etmək olar.
- [x] **Image Differencing** — eyni koordinat sisteminə uyğunlaşdırılmış iki görüntünün fərqini göstər.
- [x] **Motion Detector** — bir neçə müşahidədə görünən hərəkət namizədlərini qeyd et və ilkin görüntülərlə yoxla.
  - İşləyir (`/tools/motion`), real 3 epoxlu SPHEREx seriyasında sınaqdan keçib; 4 təsdiqlənməmiş namizəd çıxıb, real hərəkətli obyekt iddia edilmir.
- [x] **Spectrum Lab** — real dalğa uzunluğu və axın ölçmələrini vahidlər və qeyri-müəyyənliklə birlikdə göstər.
  - İşləyir (`/tools/spectrum`). IRSA-nın öz yükləməsi VOTable-dır və faktiki ixrac başlığı yoxlanmayıb; nümunə spektr sintetikdir və belə etiketlənib. Real IRSA ixracı ilə üç nöqtəlik yoxlama qalır.
- [x] Spectrophotometry (`/tools/spectrophotometry`; IRSA-nın məcburi fotometriyası ilə müqayisə hələ aparılmayıb)
- [x] Source Detection (`/tools/source-detection`; photutils/Astropy ilə müqayisə hələ aparılmayıb)
- [x] Light Curve Analysis (`/tools/light-curve-analysis`; TDB/barisentrik yollar yalnız sintetik testlərlə yoxlanıb)
- [x] Catalog Cross-Match (`/tools/catalog-cross-match`; Astropy və IRSA best-neighbour cədvəli ilə yoxlanıb)
- [x] Mosaic Builder (`/tools/mosaic-builder`; FLAGS şəkli şərh olunmur)
- [x] Məcburi Spektrofotometriya / Forced Spectrophotometry (`/tools/forced-spectrophotometry`; spxphot-un JavaScript köçürməsi, BD+17 4708 nümunəsində spxphot-un CSV-si ilə 352/352 sətir üst-üstə düşür)
  - [ ] Observation Search: IRSA formatlı kəsikləri S3-dən lokal qurmaq (spxphot `search --download cutout` kimi; IRSA kəsik xidməti CORS göndərmir və 503 qaytarır).
  - [ ] Yeni alətin tr/ru/es/zh sətirləri (hazırda yalnız az var).
  - [ ] Sérsic (qalaktika modeli) rejimini IRSA nəticələri ilə yoxlamaq: spxphot-da NGC 7619 üçün median nisbət 1.040-dır, səbəb təsdiqlənməyib.
  - Yekun kod rəyinin (14 noyabr 2026) açıq qalan tapıntıları — birləşdirmədən əvvəl düzəldilməyib, sahibin qərarı ilə sonraya saxlanıb:
    - [ ] Arxiv əlçatmaz olanda (oflayn, CORS, 403/404) icra hər kadr üçün 7 dəfə təkrar edir (~47 s), `Cancel` `fetch`-ə və gözləməyə çatmır, sorğu vaxt limiti yoxdur, xəta mətni "Failed to fetch"-dir. Həll: `AbortSignal`-ı `createHttpSource`-a ötürmək, 408/429-dan başqa 4xx-i təkrar etməmək, sorğu başına vaxt limiti, aydın mesaj, ilk N kadr hamısı şəbəkə xətası verəndə icranı erkən dayandırmaq (`tools/fits-range.js`, `tools/forced-phot.js`).
    - [ ] Lokal fayl və onun idxal edilmiş S3 əkizi (eyni OBSID + detektor) hər ikisi ölçülür → eyni `lvf_id` iki dəfə; lokal fayl qalib gəlməli, əkiz icradan çıxarılmalıdır; eyni adlı iki lokal fayl səssiz atılmamalıdır (`tools/forced-spectrophotometry.js` `linkLocalFrames`).
    - [ ] Sérsic və birgə (joint) fit yolları üçün spxphot oracle-ı yoxdur: nümunə kadrda `spxphot phot --targets` ilə (ulduz Sérsic modeli + 30″ qonşu, `--detectors 1 --mjd-min/--mjd-max 60819.418091`) ikinci oracle yaradıb 1e-9 paritet testi əlavə etmək.
    - [ ] Kadr cədvəli hündürlükcə məhdudlaşdırılmayıb (nümunədə 500 sətir səhifəni ~10 000 px aşağı itələyir) və S3 sətirlərində müşahidə adı göstərilmir (`.fs-results-wrap` kimi `max-block-size` + "Observation" sütunu).
    - [ ] Qrafikdə içiboş marker praktikada yalnız CONTAINS_BAD_PIXEL deməkdir (BD+17 4708-də bütün nöqtələr içiboşdur). Qərar: içiboş = fit-in nəzərə almadığı piksellər (FIT_IGNORE bitləri) və ya FIT_ERROR; `hollowFlags` sabiti və lejend mətni dəyişməlidir.
    - [ ] az.js: `validateShape`-in 4 rədd mesajı (Sérsic indeksi, ox nisbəti, mövqe bucağı, effektiv radius) üçün açar yoxdur; "bunu" → "bunları" (loqarifmik ox cümləsinin cəm şablonu).
    - [ ] Dalğa uzunluğu filtrinin atdığı nöqtələr hesabatda sayılmır; MJD mənası S3 kadrlarında `t_min`, lokal fayllarda `MJD-AVG`-dir (kömək mətnində bir söz).

## Hazırdır

- [x] Hərəkətli qalaktikası olan ana səhifə, dörd seçilmiş alət və **Show All** keçidi.
- [x] 13 alətin yer aldığı ayrıca Tools səhifəsi və hazırlanmaqda olan iş sahələrinin önizləmələri.
- [x] SPHEREx arxivində axtarış üçün Observation Search.
- [x] Yerli FITS fayllarını açan FITS Viewer və real SPHEREx nümunəsi.
- [x] Explore, Learn və About üçün ayrıca səhifələr.
