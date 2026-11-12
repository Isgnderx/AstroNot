# AstroNot — build promptları

Bu fayl `TODO.md`-də açıq qalan 15 iş üçün hazır tapşırıq mətnidir. Seçdiyin **Prompt** bölməsini kod yazan agentə göndər və bu fayldakı **Ortaq repo konteksti** və **Ortaq icra qaydaları** hissələrini oxumasını istə. Fayla çıxışı yoxdursa, həmin hissələri də promptla birlikdə göndər.

Əsas demo üçün `01 → 02 → 03 → 04 → 06` sırası ilə get. `05` üçün komanda məlumatlarını ayrıca topla. Görüntü analizi üçün əvvəl `07 → 08`, sonra `09` işlərini götür. `10` arxivdən alınmış spektri açır, `11` isə həmin formatda yeni ölçmə hazırlayır. `12` aşkarlanan mənbələri `09` və `14` üçün giriş kimi verə bilər. `15` işində `08`-də qurulmuş koordinat uyğunlaşdırmasından istifadə et.

## Ortaq repo konteksti

- AstroNot hazırda statik HTML, CSS və JavaScript ilə işləyir. `node serve.mjs` lokal HTTP önizləməsini açır. Hazır istifadə yollarından biri də `index.html` faylını brauzerdə birbaşa açmaqdır. `routes.js` daxilindəki `sitePage()` və `siteAsset()` funksiyaları hər iki rejimdə keçidləri qurur.
- Ana səhifədə qalaktika və dörd seçilmiş alət var. **Show All** bütün 12 alətin yer aldığı `/tools` səhifəsinə aparır. `tools/registry.js` adları, ID-ləri, kateqoriyaları və hazır olma statusunu saxlayır. `tools/catalog.js` həm ana səhifə, həm Tools üçün kartları yaradır. `tools/workspace.js` önizləmələri və köhnə `workspace.html?tool=…` keçidlərini idarə edir.
- `/tools/observation-search` və `tools/observation.js` SPHEREx üçün IRSA SIA sorğusunu hazırlayır və CSV-ni arxivdə açır. `/tools/fits-viewer` və `tools/fits.js` lokal, sıxılmamış 2D FITS görüntüsünü açır, göstərilə bilən HDU-nu seçir və başlıq məlumatlarını oxuyur. `readFitsHdus()` struktur üçün, `fitsPixelReader()` ölçü dəyərləri üçün başlanğıc nöqtəsidir. `drawFitsImage()` yalnız görüntüləmə üçün kontrast tətbiq edir.
- `/tools/sky-explorer`, `/tools/time-machine`, `/tools/spectrum` və `/tools/motion` hazırda önizləmədir. `/explore`, `/learn` və `/about` ayrıca səhifələrdir. İşlək səhifələrin başlıq, naviqasiya, panel, düymə və status üslublarını `styles.css`, `tools/workspace.css` və `tools/catalog.css` fayllarında tap.
- Paketdəki real FITS nümunəsi `assets/tools/spherex-example.js` faylındadır. Bu, SPHEREx QR2 arxivindəki `2025W21_2C_0280_1` müşahidəsinin 2-ci detektorundan alınmış kəsimdir. Paketdə boş Primary HDU və `70 × 70` ölçülü `IMAGE` HDU var. `IMAGE` üçün `BITPIX=-32`, `BUNIT='MJy / sr'`, `RADESYS='ICRS'` və `TIMESYS='UTC'` yazılıb. `DATE-OBS` dəyəri `2025-05-24T04:24:53.232`-dir. `CTYPE1='RA---TAN-SIP'`, `CTYPE2='DEC--TAN-SIP'`, `CRPIX1=-405.5`, `CRPIX2=-63.5` və üçüncü dərəcəli SIP əmsalları var. `CRVAL` istinad nöqtəsinə aiddir. Kəsimin faktiki mərkəzini piksel koordinatından hesabla. Arxiv kəsiminə keçid və mənbə krediti README-dədir. [NASA/IPAC IRSA SPHEREx Quick Release](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html) · [IRSA Cutout Tool](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html)

## Ortaq icra qaydaları

1. Seçilən işi başdan sona həyata keçir. Əvvəl `TODO.md`, `README.md` və adı çəkilən faylları oxu. Cari vəziyyəti yoxla, uyğun olan kodu təkrar istifadə et və mövcud dəyişiklikləri qoruyaraq işlək nəticə ver.
2. Ekran mətnlərini AstroNot-un hazır ingilis dilində yaz. Tünd fonu, Inter şriftini, mövcud panel və düymə üslublarını saxla. Əsas əməliyyatlar klaviatura ilə işləsin, fokus görünsün, statuslar anlaşılır olsun. Mobil ekranda girişlər və nəticələr oxuna bilsin.
3. Giriş formatını və dəstəklənən elmi halları dəqiq göstər. Dataset, buraxılış, müşahidə ID-si, HDU, vahid, koordinat sistemi və tarix kimi məlumatları mənbədən götür. Məlumat çatışmırsa həmin sahəni boş və ya **Unavailable** göstər. Nümunə görüntü, arxiv məlumatı və avtomatik test üçün yaradılmış süni massivlər fərqli məqsədlər daşıyır. Test massivlərini arxiv nəticəsi kimi təqdim etmə.
4. Xam və kalibrasiya edilmiş piksel dəyərlərini göstərmə rənglərindən ayrı saxla. `BLANK`, `NaN`, maska, ölçmə xətası və sıfır üçün fərqli hallar müəyyən et. Ölçmə və ixrac hesablamaları görüntü kontrastı, zoom və canvas rənglərindən asılı olmasın.
5. Uzun əməliyyatın görünən statusu olsun. İstifadəçi girişi dəyişəndə əvvəlki nəticə yeni girişə aid görünməsin. Dəstəklənməyən fayl, format, vahid və ölçü üçün səbəbi göstər. Xarici xidmət, paketin yeni versiyası və əlavə iş mühiti barədə qərar verməzdən əvvəl sənədi və faktiki işləmə şəraitini yoxla.
6. Alətin normal girişini `/tools` kataloqundan və ünvanı birbaşa açmaqla sına. Yeni iş sahəsi əlavə olunanda `tools/registry.js` və köhnə ID keçidini uyğunlaşdır. `available: true` statusunu yalnız əsas əməliyyat real girişlə yoxlanandan sonra ver. FITS Viewer, Observation Search, ana səhifə və **Show All** kimi hazır girişlər üçün uyğun geriyə uyğunluq yoxlamasını apar.
7. Qəbul meyarlarına uyğun testləri işə sal. Real məlumatla görülən nəticəni ayrıca qeyd et. `TODO.md`-də yalnız tamamlanmış işi işarələ. Sonda dəyişən faylları, işlək yolu, yoxlama nəticəsini və qalan konkret asılılığı qısa yaz.

## Prompt 01 — Observation Search-dən FITS Viewer-ə keçid

AstroNot-da müşahidəni tapmaqdan həmin müşahidənin FITS görüntüsünü açmağa qədər olan yolu qısalt. İstifadəçi **Use SPHEREx example** ilə sorğunu doldursun, arxivdəki real müşahidə sətirlərini görə bilsin və seçdiyi sətirin uyğun FITS faylını FITS Viewer-də aça bilsin.

### Başlanğıc və sərhəd

- `tools/observation-search/index.html`, `tools/observation.js`, `tools/fits-viewer/index.html`, `tools/fits.js` və `routes.js` fayllarını oxu. Hazır sorğu ICRS koordinatları, radius, istəyə bağlı UTC tarixləri və dalğa uzunluğu qəbul edir. Məlumat mənbəyi `spherex_qr2`-dir. Mövcud `buildObservationQuery()` funksiyasını sorğu üçün əsas götür.
- Mövcud nümunədə RA `156.09328159°`, Dec `−41.64466331°`, tarix `2025-05-24`, dalğa uzunluğu `1.2–1.4 μm`-dir. Giriş dəyərlərini hazır formadan götür. SIA sorğusunda `POS`-un dərəcə ilə, `TIME`-ın MJD ilə, `BAND`-ın metr ilə ifadəsini xidmət sənədi və faktiki sorğu ilə yoxla. Açıq tarix aralığı və sorğu nəticələrinin sayı ilə bağlı davranışı sənəddən təsdiqlə. [IRSA SIA v2 sorğuları](https://irsa.ipac.caltech.edu/ibe/sia.html)
- İlk versiya üçün QR2 və sənədləşdirilmiş FITS çıxışı kifayətdir. Tam spektral görüntü böyük ola bilər. Kiçik sahə lazım olduqda arxivin sənədləşdirilmiş `center` və `size` parametrləri ilə kəsim al. Kəsim mərkəzi və ölçüsü istifadəçiyə dərəcə ilə görünsün. [IRSA SPHEREx kəsim xidməti](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html)

### İstifadə yolu

1. Nəticələri brauzerdə gətirməyin mümkünlüyünü real HTTP rejimində yoxla. Arxiv cavabı brauzerdən oxuna bilirsə, eyni hazırlanmış SIA sorğusundan nəticələri al və səhifədə göstər. Xidmət brauzerin cavabı oxumasına icazə vermirsə, **Open IRSA results (CSV)** ilə nəticəni aç və ya endir, sonra **Import IRSA CSV** ilə həmin faylı səhifəyə qaytar. Hər iki yol seçilən müşahidəyə aparmalıdır. Layihənin hazır yerləşdirmə mühitində bu iş üçün sənədləşdirilmiş server marşrutu varsa, onu istifadə etməzdən əvvəl mövcud giriş və çıxış məhdudiyyətlərini yoxla.
2. CSV-ni dırnaq, vergül, sətirsonu, boş sətir və UTF-8 BOM halları ilə düzgün oxu. Rəsmi cavabdan tələb olunan sütunları müəyyən et. Ən azı müşahidə identifikatoru və etibarlı fayl keçidi tələb et. Tarix, dalğa uzunluğu intervalı və məhsul formatı mövcud olanda sətirdə göstər. Sütunlar çatışmırsa, fayl tipi uyğun gəlmirsə və ya cavab xidmət xətasıdırsa, sətirləri etibarlı müşahidə kimi göstərmədən səbəbi izah et. Məlumat mətnini DOM-a mətn kimi yerləşdir.
3. Hər açılan sətirdə **Download FITS** və **Open in FITS Viewer** əməliyyatlarının nəticəsi aydın olsun. Arxiv URL-sini sənədləşdirilmiş HTTPS host və məhsul yolu üzrə doğrula. Endirmə seçilən sətirə aid fayla və ya həmin faylın kəsiminə aparsın. Birbaşa yükləmə mümkün olduqda Viewer-in hazır HDU oxuma yolundan keç. Lokal fayl rejimində endirmə və Viewer-də **Choose a local FITS file** ilə açma addımlarını bir-birinə bağla. Arxivdən başqa nümunə açılırsa, onu ayrıca **Load SPHEREx example** kimi göstər.
4. Yüklənmə, nəticəsiz sorğu, limitə çatmış cavab, alınmayan fayl, şəbəkə problemi və ləğv edilən sorğu üçün fərqli statuslar qur. Yeni sorğu köhnə cavabı əvəz etsin. Eyni düyməyə ardıcıl basılanda əvvəlki cavab yeni nəticə üzərində görünməsin. CSV-də nəticə limiti barədə təsdiqlənən məlumat varsa, onu istifadəçiyə göstər.

### Qəbul meyarları

- Real nümunəni əvvəlcə `/tools/observation-search` ünvanından aç. Sorğunu göndər, arxiv cavabından bir sətir seç, həmin sətirin FITS faylını və ya rəsmi kəsimini əldə et. `/tools/fits-viewer` üzərində onu göstər və açılan FITS başlığındakı müşahidə identifikatorunu seçilən sətirlə tutuşdur. Nəticə sayını əvvəlcədən sabit götürmə.
- Arxivə çıxış yolunu, CSV idxalını, seçilən sətiri və Viewer-dəki HDU-nu klaviatura ilə tamamla. Mövcud lokal fayl yükləməsi və ayrıca paket nümunəsi işləsin.
- Vergüllü və dırnaqlı CSV sahəsi, sıfır sətir, çatışmayan fayl sütunu, uyğun gəlməyən URL, etibarsız tarix intervalı və ardıcıl iki sorğu ilə yoxla. Uğurlu yoxlamada istifadə etdiyin dataset, müşahidə ID-si, endirilən məhsulun növü və Viewer-də görünən ölçünü yekunda qeyd et.

## Prompt 02 — Sky Explorer-in ilk işlək versiyası

`/tools/sky-explorer` ünvanındakı önizləməni real SPHEREx görüntüsünü aça bilən iş sahəsinə çevir. İlk açılışdan bir nümunə seçmək, görüntünü yaxınlaşdırmaq, üzərində hərəkət etmək və görünən sahənin göy koordinatlarını oxumaq mümkün olsun.

### Görüntü və interfeys

- `tools/sky-explorer/index.html`, `tools/workspace.js`, `tools/registry.js`, `tools/fits.js` və `assets/tools/spherex-example.js` fayllarını yoxla. FITS strukturunu və kalibrasiya edilmiş piksel oxunuşunu Viewer ilə paylaş. Lazım gələrsə oxuyucunu UI-dən ayır və hazır Viewer-in normal girişini yenidən sına.
- İlk versiya üçün paketdəki `70 × 70` real SPHEREx QR2 görüntüsünü **Load SPHEREx example** ilə aç. Dəstəklənən lokal 2D FITS faylını seçmək imkanı da ver. Mənbə, müşahidə ID-si, HDU, ölçülər, `BUNIT` və varsa müşahidə tarixini görüntünün yanında göstər. Önizləmədə istifadə edilən dekorativ astronomiya şəklini koordinat hesabına daxil etmə.
- Görüntü panelində **Zoom in**, **Zoom out**, **Fit image** və ya **Reset view** düymələri olsun. Siçan və toxunma ilə sürüşdürmə, klaviaturada ox düymələri ilə hərəkət və düymələrlə zoom işləsin. Fokus paneldən kənara çıxa bilsin. Toxunma ilə sürüşdürmə görüntü daxilində proqnozlaşdırılsın, səhifənin qalan hissəsi normal şaquli sürüşsün.
- Mərkəzin RA/Dec dəyərini göstəricinin altındakı RA/Dec-dən ayrı göstər. Dəyərlər üçün `ICRS` və dərəcə vahidini yaz. Görünən baxış sahəsini üfüqi və şaquli bucaq olaraq göstər. Məlumatdan kənara çıxıldıqda statusu aydın göstər. Klaviatura ilə mərkəzə baxan istifadəçi də eyni məlumatı oxuya bilsin.

### Koordinatların hesablanması

1. WCS açarlarını faktiki görüntü HDU-sundan götür. Paket nümunəsi `RA---TAN-SIP` və `DEC--TAN-SIP` istifadə edir. Həmin fayl üçün `PC` matrisi, `CDELT`, `CRVAL`, mənfi ola bilən `CRPIX` və SIP əmsalları tətbiq olunmalıdır. İşlənən WCS profillərini açıq sənədləşdir. Qalan profillərdə piksel görünüşü və WCS statusu ayrıca əlçatan olsun. [FITS WCS](https://fits.gsfc.nasa.gov/fits_wcs.html) · [Astropy WCS](https://docs.astropy.org/en/stable/wcs/)
2. Ekran koordinatını zoom, pan, panelin ölçüsü və görüntünün göstərilmə istiqaməti əsasında ilkin FITS pikselinə çevir. Canvas sətirlərinin yuxarıdan aşağı göstərilməsi ilə FITS piksel oxları arasındakı çevrilməni bir yerdə saxla. FITS-in istinad pikseli və kitabxananın piksel başlanğıcı fərqlənə bilər. Başlanğıc konvensiyasını kodda və testdə aydın et. `CRVAL`-ı görüntünün mərkəzi hesab etmək üçün əvvəl mərkəz pikseli həmin nöqtəyə uyğun gəlməlidir.
3. Baxış sahəsini cari görünüşün ortasından keçən sol və sağ, yuxarı və aşağı sərhəd nöqtələrinin göy koordinatları arasındakı bucaqla hesabla. Paneldə boş kənarlar varsa, ölçülən hissənin görüntü sahəsi olduğunu göstər. RA-nı `[0°, 360°)` aralığında göstər. Qütb və `0°/360°` keçidində bucaq məsafəsini kürə üzərində hesabla. WCS çevrilməsi alınmadıqda sadə piksel sayını bucaq kimi göstərmə.
4. Rəng və kontrast yalnız görüntüləməyə aid olsun. Pan və zoom dəyişəndə FITS faylını yenidən oxuma. Ekran koordinatı dəyişdikdə ancaq lazımi hissəni yenilə və klaviatura statusunu hər kursor pikseli üçün elan etmə.

### Qəbul meyarları

- Real nümunənin mərkəzi, mərkəzdən kənar ən azı iki nöqtə və görüntünün görünən sərhədləri üzrə WCS hesabını müstəqil etalonla müqayisə et. Etalon üçün eyni FITS başlığı ilə Astropy WCS və ya uyğun müstəqil proqramdan istifadə et. Bu nümunə üçün gözlənilən koordinatları icra zamanı hesabla və toleransı, məsələn `0.1 arcsec`, sınaqla əsaslandır.
- Eyni göy nöqtəsinə iki fərqli zoom və pan vəziyyətində baxanda koordinat uyğun qalsın. Tərs çevrilmə dəstəklənirsə, piksel → göy → piksel yoxlamasını apar. Görüntünün künc və mərkəzini fərqli edən, ekranda Y çevrilməsini tutan və `CRPIX` görüntünün xaricində olan halları sına.
- WCS açarları olmayan FITS-də şəkil və piksel görünüşü işləsin, RA/Dec və baxış sahəsi üçün **Unavailable** görünsün. Faylın ölçüsü və tipi dəstəklənməyəndə aydın mesaj göstər. Desktop və mobil ölçüdə kataloqdan giriş, nümunə yükləmə, zoom və klaviatura pan yolunu yoxla. Yalnız bu yoxlamalardan sonra Sky Explorer-i kataloqda istifadəyə aç.

## Prompt 03 — Mobil, klaviatura və xəta halları

AstroNot-un əsas istifadəsini telefonda və klaviatura ilə sına və müşahidə etdiyin problemləri düzəlt. Əsas istifadə yolu ana səhifə → **Show All** → Tools → Observation Search → FITS Viewer-dir. Sky Explorer artıq istifadəyə açıqdırsa onu da sına. Bir iş sahəsi hələ önizləmədirsə, həmin vəziyyətin aydın görünməsini və önizləmə keçidini yoxla.

### Yoxlanacaq davranışlar

1. `320`, `390`, `768` və `1440` CSS piksel enində ana səhifə, Tools və aktiv iş sahələrini aç. Səhifə səviyyəsində üfüqi daşma, başlıq və düymə kəsilməsi, görünməyən fokus və məlumat örtüşməsi kimi qüsurları tap. Alət kartlarının öz üfüqi sürüşmə sahəsi istifadəçiyə tanış sürüşdürmə və klaviatura ilə işləsin.
2. Yalnız klaviatura ilə skip link, mobil menyu, **Show All**, kateqoriya filtrləri, kart keçidləri, forma, fayl seçimi, HDU seçimi və zoom nəzarətlərini keç. Fokus sırası DOM və ekrandakı məntiqli sıraya uyğun olsun. Menyu və açılan panel bağlandıqdan sonra fokus uyğun düyməyə qayıtsın. Pan əməliyyatına klaviatura yolu olan iş sahəsində fokus paneldə ilişməsin. [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)
3. Observation Search-də başlanğıc, sorğu hazırlanıb, cavab gözlənilir, nəticə var, nəticə boşdur, yanlış parametr və arxiv xətası hallarını yoxla. Səhifə yalnız link hazırlayırsa, status da həmin əməliyyatı bildirsin. Axtarış cavabı əldə edilirsə, boş nəticə ilə şəbəkə xətasını ayrı göstər. İstifadəçi təkrar sorğu göndərə və ya filtrləri dəyişə bilsin.
4. FITS Viewer-də fayl seçilməyib, FITS oxunur, düzgün fayl açılıb, HDU görüntülənə bilmir, fayl yararsızdır və ölçü həddini keçir hallarını ayrı yoxla. Yararlı fayldan yararsız fayla keçəndə məlumatın hansı fayla aid olduğu aydın qalsın. Yararsız fayldan sonra yeni fayl seçərək bərpa yolunu sına. Əməliyyatdan sonra status ekran oxuyucusu üçün elan olunsun. Gözləmə mesajı təkrar klaviatura basışı yaratmasın.
5. Ana səhifədə avtomatik qalaktika animasiyasını və əməliyyat sistemində azaldılmış hərəkət seçimini yoxla. Sürüşmə keçidlərində və kart animasiyalarında bu seçim nəzərə alınsın. Gələcəkdə Blink kimi aktiv hərəkət olan iş sahəsi varsa, onun ayrıca başlatma və dayandırma nəzarəti fokusla işləsin.

### Qəbul meyarları

- Əsas yolu ən azı bir desktop və bir mobil ölçüdə əvvəldən sona tamamla. Bir real FITS nümunəsi, bir yararsız fayl və müşahidə nəticəsi boş olan idarə olunan bir hal ilə sına. Arxivdən asılı testi təkrarlana bilən test cavabından ayrı qeyd et.
- Tapılan qüsurun səbəbini düzəlt və eyni addımlarla yenidən yoxla. Dəyişiklik real Chrome, Firefox və ya Safari-də sınaqdan keçibsə brauzeri yaz. Telefon emulyasiyası istifadə olunubsa bunu cihaz sınağı kimi təqdim etmə.
- Yekunda yoxlanmış ölçüləri və giriş üsulunu, keçən əsas yolları və fiziki cihazda yoxlanmalı qalan konkret halları göstər. Düzəliş verilən alətdə forma və elmi nəticə davranışının dəyişmədiyini praktik sınaqla təsdiqlə.

## Prompt 04 — Learn bölməsində real FITS təlimatı

`/learn` səhifəsinə istifadəçinin bir real SPHEREx FITS görüntüsünü açmasına kömək edən qısa təlimat əlavə et. İstifadəçi təlimatı oxuyub Observation Search və FITS Viewer arasında hərəkət edə bilsin. Hazır `Reading starlight` məzmununu və `#research` keçidini qoruyaraq yeni bölməyə `#fits-guide` kimi sabit bir ünvan ver.

### Məzmun və keçidlər

- `learn/index.html`, `tools/observation-search/index.html`, `tools/fits-viewer/index.html`, `routes.js`, `README.md` və paketdəki real FITS nümunəsini oxu. Təlimatın əsas yolu arxiv nəticəsinə çıxışdan asılı olmadan işləsin. Arxiv müşahidəsindən keçid isə Prompt 01-də həqiqətən qurulmuş düymə və addımları izah etsin.
- Birinci addımda **FITS Viewer**-i aç və **Load SPHEREx example** ilə real nümunəni yüklə. İkinci addımda `IMAGE` HDU-sunu seç və `70 × 70` ölçülü görüntünü tap. Üçüncü addımda başlıqdan `OBSID`, `DATE-OBS` və `BUNIT` məlumatlarını oxu. Hər addımda istifadəçinin ekranda nəyi görəcəyini bir cümlə ilə de.
- Qısa izahda FITS faylının görüntü və başlıq məlumatlarını bir yerdə saxlaya bildiyini göstər. Bu nümunədə Primary HDU məlumat başlığını, `IMAGE` isə görüntü massivini daşıyır. `DATE-OBS` müşahidə vaxtıdır. `BUNIT='MJy / sr'` pikselin səthi parlaqlıq vahidini bildirir. Viewer-də boz rəngin kontrastla göstərildiyini qeyd et. Təsvirin rəng dəyərindən elmi axın ölçmək üçün xam kalibrasiya edilmiş məlumat lazımdır. [FITS standartı](https://fits.gsfc.nasa.gov/fits_standard.html)
- **Open Observation Search** və **Open FITS Viewer** keçidlərini `sitePage()` yanaşması ilə qur. Axtarış səhifəsində qısa **FITS guide** keçidi həmin bölməyə qayıtsın. Viewer-də təlimat linkinə real ehtiyac varsa onu fayl seçimi yanında yerləşdir. `file://` və HTTP rejimlərində hədəfi ayrıca yoxla.
- Vizual material gərəklidirsə, paketdəki FITS önizləməsini və ya həqiqi görüntüləyici ekranını istifadə et. Şəkil altında SPHEREx QR2, müşahidə ID-si və NASA/IPAC IRSA kreditini göstər. Hazır README-dəki orijinal kəsim keçidini mənbə kimi saxla. [SPHEREx arxiv materialları](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html)

### Qəbul meyarları

- Təlimatı ilk dəfə görən istifadəçi 3–5 addımda nümunəni açıb görüntü ölçüsünü və müşahidə ID-sini tapa bilsin. Düymə adları ekrandakı mətnlərlə eyni olsun.
- `/learn#fits-guide` ünvanı birbaşa açıldıqda bölmə görünür. Mobil ölçüdə addımlar və keçidlər oxunaqlıdır. Mövcud Learn sualları və Reading starlight bölməsi açılır.
- Mətnin nümunə faylındakı tarix, ölçü, müşahidə ID-si və vahidlə uyğunluğunu başlıqdan yoxla. Qısa yoxlama hesabatında həm paket nümunəsi yolunu, həm arxivdən Viewer-ə keçidi təsdiqlə.

## Prompt 05 — About bölməsində komanda profilləri

`/about` səhifəsindəki Team hissəsini təsdiqlənmiş komanda məlumatları ilə tamamla. Ziyarətçi layihə üzvlərinin adını, rolunu və AstroNot-a töhfəsini bir baxışda görə bilsin.

### Məlumat və səhifə

1. `about/index.html`, `styles.css`, `README.md` və komanda məlumatının saxlandığı məlum repo fayllarını oxu. Hazır Mission mətnini və Team başlığını saxla. İstifadəçinin təqdim etdiyi adları, rolları və bio mətnlərini olduğu kimi əsas götür. Git tarixçəsindəki ad, məlumat arxivinin krediti və xarici təşkilatın adı ayrıca təsdiq olmadan komanda profili üçün əsas sayılmır.
2. Hər təsdiqlənmiş profil üçün ad, layihədə rol və bir-iki cümləlik töhfə mətni göstər. Şəkil və profil linki yalnız ictimai göstərilməsi təsdiqlənəndə daxil edilsin. Şəkil yoxdursa ad və rol ilə mətn profili qur. Profilin boş sahələri üçün görünən etiket yaratmağa ehtiyac yoxdur.
3. Bir üzv olduqda sadə profil, bir neçə üzv olduqda tünd fon üzərində oxunaqlı profil düzülüşü istifadə et. Semantik başlıq ardıcıllığını saxla. Şəkil varsa onun alt mətnini, ölçüsünü və mobil kəsimini yoxla. Ad uzun olsa və ya bio uzansa, kart eni və fokus göstəricisi düzgün qalsın.
4. Mənbə krediti və komanda üzvlüyünü ayrı məzmun kimi saxla. NASA/IPAC və başqa arxiv kreditləri onların AstroNot komandasında olması anlamına gəlməsin. Xarici profil keçidi görünən mətn və etibarlı hədəf ilə açılsın.
5. Təsdiqlənmiş məlumat çatışmırsa, mövcud **Team profiles are coming soon** vəziyyətini saxla və hazır UI işini tamamla. Tamamlamaq üçün lazım olan ad, rol, bio və foto/link icazəsini bir yerdə dəqiqləşdir. Hazır məlumat olan profillər varsa, həmin hissələri əvvəl yerləşdir.

### Qəbul meyarları

- Göstərilən hər ad, rol, bio və şəkil istifadəçinin təsdiqlədiyi mənbəyə uyğundur. Komanda məlumatı olmadığı halda gələcək profil statusu aydın görünür.
- `/about` birbaşa açılır, desktop və telefonda Team bölməsi daşmır, profil linkləri klaviatura ilə işləyir. Mission və əsas naviqasiya açılır.
- Hesabatda yerləşdirilən profillərin sayını və çatışmayan konkret materialı yaz. `TODO.md` işarəsini təsdiqlənmiş profillər yerləşdirilib yoxlanandan sonra dəyiş.

## Prompt 06 — Paylaşılan demo önizləməsi

AstroNot-u paylaşmaq üçün yoxlanıla bilən önizləmə hazırla. Məqsəd başqa bir istifadəçinin HTTPS ünvanından ana səhifəni açması, **Show All** ilə Tools-a keçməsi və istifadəyə açıq iş sahəsini işə salmasıdır.

### Paket və yerləşdirmə

1. `README.md`, `serve.mjs`, `routes.js`, qovluq girişlərini, repo daxilində varsa mövcud yerləşdirmə konfiqurasiyasını və istifadəçinin seçdiyi hədəfi yoxla. `node serve.mjs` lokal önizləmə üçündür. Paylaşılan demo üçün istifadəçinin artıq seçdiyi və icazə verdiyi mühiti əsas götür.
2. Demo paketinə yalnız ictimai HTML girişləri, JS, CSS, şriftlər, görüntülər və göstərilməli nümunə məlumatlarını daxil et. Dəyişiklikləri bir artefaktda və ya önizləmə branch-ində yoxla. `.git`, yerli konfiqurasiya, açarlar və layihədaxili iş faylları veb çıxışında yer almasın. Yayım mühitinin statik qovluq girişlərini və fayl növlərini necə təqdim etdiyini onun sənədləri ilə yoxla. GitHub Pages istifadə olunursa layihə alt qovluğundakı asset və səhifə keçidlərini həmin quruluşda da sına. [GitHub Pages yerləşdirmə sənədi](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
3. `/`, `/tools`, `/explore`, `/learn`, `/about` və istifadəyə açıq iş sahələrinin birbaşa ünvanlarını aç. `/tools/sky-explorer`, `/tools/time-machine`, `/tools/spectrum` və `/tools/motion` ünvanlarının həmin anda düzgün vəziyyətini göstərdiyini yoxla. İç-içə səhifələrdə JS, CSS, şrift və lokal FITS nümunəsinin yükləndiyini təsdiqlə. Hardkod olunmuş hostdan asılı asset keçidi varsa, `sitePage()` və `siteAsset()` modelinə uyğun düzəlt.
4. Hazır mühitdə səlahiyyət və hədəf təsdiqlənibsə önizləməni yerləşdir. Servis açıq HTTPS ünvanı qaytardıqdan sonra yoxlamaları həmin ünvanda təkrar et. Məxfi və ya ictimai görünmə tələbi istifadəçinin seçimi ilə müəyyənləşsin. Hədəf üçün məlumat çatışmırsa, lokalda sınanmış paketi, run əmrini və istifadəçidən lazım olan konkret məlumatı hazır saxla.
5. Yenilənən demo üçün işlək versiyanın commit və ya başqa aydın identifikatorunu qeyd et. Birbaşa səhifəyə girmə, brauzeri yeniləmə, geri qayıtma və yeni tabda açma halları eyni məzmuna aparsın. Observation Search-in arxivə çıxışını və FITS Viewer-in paket nümunəsini demo mühitində ayrıca yoxla.

### Qəbul meyarları

- Paylaşılan link varsa, onun yeni brauzer sessiyasında açıldığını gör. Ana səhifə → **Show All** → Tools → hazır iş sahəsi → nümunə yolu həmin hostda tamamlanır. Ən azı bir mobil ölçüdə də bunu sına.
- Birbaşa iç-içə URL və səhifə yeniləmə düzgün işləyir. Qəsdən mövcud olmayan yol uyğun 404 davranışı verir. Sayt yalnız yayım üçün nəzərdə tutulmuş faylları servis edir.
- Yekunda faktiki işləyən önizləmə URL-sini, yoxlanmış yolları və varsa çatışmayan yerləşdirmə şərtini qeyd et. Yalnız lokal run olubsa onu lokal önizləmə kimi göstər və açıq link tapşırığını gözləmədə saxla.

## Prompt 07 — Time Machine ilə iki müşahidəni müqayisə et

`/tools/time-machine` səhifəsində eyni göy sahəsinin iki real müşahidəsini yan-yana açan Time Machine qur. İstifadəçi hansı görüntünün hansı tarixə, sahəyə və müşahidəyə aid olduğunu görə bilsin. Əsas iş lokal FITS faylları ilə başlasın. Hazır arxiv yolu varsa, həmin yolla əldə edilmiş FITS faylları da eyni oxuyucudan keçsin.

### Giriş və müqayisə

- `tools/time-machine/index.html`, `tools/registry.js`, FITS Viewer oxuyucusu və Sky Explorer-in WCS kodu varsa onları oxu. İki girişə **Reference observation** və **Comparison observation** adlarını ver. Hər birindən göstərilə bilən görüntü HDU-sunu seçmək, faylı dəyişmək və müstəqil xəta mesajını görmək mümkün olsun.
- Başlıqdan müşahidə ID-si, HDU, ölçü, vahid, koordinat sistemi, dalğa uzunluğu və etibarlı müşahidə vaxtını mümkün olduqda göstər. Vaxt üçün `DATE-OBS`, `MJD-OBS` və `TIMESYS` istifadə et. Faylın emal vaxtı olan `DATE` ayrı metadata kimi qala bilər. Vaxt çatışmırsa **Observation time unavailable** göstər. Əl ilə daxil edilmiş tarixə mənbə işarəsi ver. [Astropy vaxt və tarix](https://docs.astropy.org/en/stable/time/index.html)
- WCS vasitəsilə eyni göy sahəsinin kəsişməsini müəyyən et. Ölçüləri eyni olan iki rasterin göydə üst-üstə düşdüyünü ayrıca təsdiqlə. Hər iki görüntü eyni etibarlı grid üzərindədirsə, pan və zoom-u bağlamaq olar. Fərqli gridlərdə yan-yana müstəqil baxış ver. Əgər etibarlı uyğunlaşdırma artıq varsa, hər iki panelin koordinat uyğunluğunu qoruyan ortaq görünüşü həmin kodla qur.
- Müqayisədə görüntü kontrastını idarə etmək mümkün olsun. Ölçü vahidləri müqayisə edilə bilirsə ortaq kontrast aralığı faydalıdır. Ayrı aralıq seçiləndə hər panel bunu göstərsin. Tarix, müşahidə və işarələnmiş nöqtə görüntü dəyişəndə mənbə faylına bağlı qalsın.
- Etibarlı tarixlər olan müşahidələr üçün qısa zaman xətti göstər. **Blink** yalnız eyni sahəyə və etibarlı ortaq gridə malik görüntülərdə aktivləşsin. Müqayisə əvvəlcə sabit qalsın. İstifadəçi Blink-i açıb dayandıra, sürəti oxunaqlı həddə dəyişə və bir kadrı klaviatura ilə seçə bilsin. Azaldılmış hərəkət seçimi olduqda standart başlanğıc sabit görünüş olsun.
- Fayllar fərqli band, filtrlər və ya ekspozisiya şərtlərindədirsə onları aydın göstər. İki şəkil arasında parlaqlıq və mövqe fərqinə elmi şərh vermək üçün müqayisənin şərtləri ekranda oxunaqlı olmalıdır.

### Qəbul meyarları

- Arxivdən eyni sahənin fərqli vaxtlarda əldə olunmuş iki real, mümkün qədər müqayisə olunan müşahidəsini seç. Hər ikisini aç, mənbə və başlıq dəyərlərini təsdiqlə. Eyni faylın surətini fərqli tarix kimi təqdim etmə.
- Sol və sağ rolları dəyişəndə etiket, tarix və şəkil birlikdə dəyişir. Zaman xətti etibarlı tarixləri düzgün sıralayır. Yeni fayl əvvəlki nəticəni köhnə mənbəyə bağlamır. Yanlış WCS, eyni tarix, örtüşməyən sahə və oxunmayan fayl ayrı hallarda sınaqdan keçir.
- Pan, zoom və kadr seçimi telefon və klaviatura ilə işləyir. Blink yalnız uyğun cütlükdə başlaya bilir və dayandırma faktiki animasiyanı saxlayır. Alət real cütlüklə yoxlandıqdan sonra kataloqdan istifadəyə açılsın.

## Prompt 08 — Image Differencing ilə uyğun görüntüləri çıx

AstroNot-a iki uyğunlaşdırılmış FITS görüntüsünün fərqini göstərən `/tools/image-differencing` iş sahəsi əlavə et. Kataloqdakı `image-differencing` ID-sini istifadə et. Əsas nəticə `target − reference` əməliyyatından yaranan işarəli fərq görüntüsü və onun etibarlı piksel sahəsidir.

### Giriş və hesab

1. FITS oxuyucusunu, Sky Explorer-in WCS çevrilməsini və Time Machine müqayisə modelini nəzərdən keçir. `Reference` və `Target` faylları üçün görüntü HDU-su, müşahidə ID-si, zaman, `BUNIT` və band məlumatı seçilə bilsin. Xam dəyərlərə FITS `BSCALE` və `BZERO` çevrilməsini bir dəfə tətbiq et. Maskalanmış və yararsız pikselləri ayrıca saxla.
2. Hər iki görüntünün eyni səma sahəsini örtməsini və müqayisə üçün vahid və kalibrasiya uyğunluğunu yoxla. Bir grid üzərində olduqları halda bunu WCS ilə təsdiqlə. Eyni ölçü təkbaşına kifayət etmir. Fərqli gridlər üçün rəsmi WCS-ə əsaslanan yenidən proyeksiya varsa hədəfi istinad gridinə gətir və örtüşmə maskasını hesabla. Proyeksiya dəstəklənmirsə, uyğunlaşdırılmış giriş tələb et və səbəbi göstər. [Celestial reprojection](https://docs.astropy.org/projects/reproject/en/stable/celestial.html)
3. Mənbələr eyni ölçü vahidinə gətirildikdən sonra hər iki görüntüdə etibarlı olan piksellərdə fərqi hesabla. `Δ = target − reference` işarəsini UI-də görünən etiketlə göstər. Üst-üstə düşməyən, `NaN` olan və ya maskalanmış pikselləri nəticədə etibarsız saxla. Örtüşmə maskası boşdursa, nəticə paneli bunu bildirsin.
4. Fon, PSF və görüntü miqyası fərqlərinin qalıqlar yarada bildiyini nəzərə al. PSF uyğunlaşdırması və fon korreksiyası tətbiq edilirsə onların metodunu və parametrini göstər. Sadə çıxma rejimini piksel fərqi kimi təqdim et. Onun elmi şərhi istifadə olunan band, kalibrasiya və uyğunlaşdırmanın keyfiyyətindən asılıdır.
5. Hər iki faylın eyni vahidə çevrilmiş etibarlı dispersiya məlumatı varsa, müstəqil xətalar halında `Var(Δ) = Var(target) + Var(reference)` hesabından istifadə etmək olar. Yenidən proyeksiya və ya başqa çevrilmə korrelyasiya yaradırsa tətbiq olunan yaxınlaşmanı göstər. Dispersiya məlum olmayan pikseldə fərq görünə bilər, SNR sahəsi boş qalır.

### Görünüş və təhvil

- İstinad, hədəf və fərq panellərini göstər. Fərq üçün sıfır mərkəzli işarəli rəng şkalası, legenda və vahid ver. Bir piksel seçiləndə həmin pikseldəki iki giriş və fərq dəyərini görmək mümkün olsun. Klaviatura ilə seçilən nöqtə də eyni rəqəmləri oxuya bilsin. Görüntü kontrastı hesablamanı dəyişməsin.
- Sonrakı Motion Detector işi üçün uyğunlaşdırılmış görüntüləri, fərq massivini, örtüşmə maskasını, WCS-i, vahidi və iki müşahidə identifikatorunu təkrar istifadə edilə bilən nəticə kimi saxla. Fayl ixracı əlavə edilirsə çıxış formatında istiqamət, vahid, maska və uyğun koordinat başlığı qorunsun.

### Qəbul meyarları

- Sınaq üçün `reference = [4, 8, 10, NaN]` və `target = [7, 6, 10, 5]` massivlərini istifadə et. Gözlənilən nəticə `[3, −2, 0, NaN]`-dir. Eyni grid və müstəqil dispersiyalarda `4 + 9 = 13` nümunəsini yoxla. Bu massivlər yalnız avtomatik sınaq üçündür.
- Çıxma istiqamətini, vahid uyğunsuzluğunu, WCS dönməsini, qismən örtüşməni və etibarsız piksel davranışını sına. Gerçək uyğun müşahidə cütündə nəticənin əsas sahəsi, mənbə identifikatorları və sıfır mərkəzli rəng şkalası görünsün. Nəticəni işlək Tools kartından açaraq yoxla.

## Prompt 09 — Motion Detector ilə hərəkət namizədlərini tap

`/tools/motion` səhifəsində fərqli vaxtlarda alınmış uyğun müşahidələrdən mümkün hərəkət namizədlərini tapmağa və hər namizədi ilkin görüntülərdə yoxlamağa imkan ver. Başlanğıc model Time Machine-in müşahidə cütü və Image Differencing-in uyğunlaşdırılmış görüntüləridir.

### Giriş və namizəd hesabı

- `tools/motion/index.html`, `tools/registry.js` daxilindəki `moving-object-analysis` qeydi, WCS çevrilməsi, fərq şəkli və müşahidə vaxtını oxuyan kodu yoxla. Hər müşahidənin ID-si, etibarlı vaxta aid metadata, vahidi və ortaq görüntü gridində yeri izlənə bilsin. Cütlük üçün `Δt` sıfırdırsa və ya vaxt məlum deyilsə, sürət sahəsini boş saxla və səbəbini göstər.
- İlk versiyada fərq şəklindəki etibarlı sahədə yerli maksimum və minimumları müəyyən et. Həddi istifadəçinin seçə bildiyi aydın vahidlə göstər. Dispersiya məlumdursa işarəli SNR istifadə etmək olar. Dispersiya məlum deyilsə, yerli fon dəyişkənliyi və ya giriş vahidində hədd istifadə et və metodun adını yaz. Mənfi və müsbət qalıqların hansı çıxma istiqamətinə aid olduğunu göstər. Kənarları, maskalanmış pikselləri və örtüşməyən sahəni namizəd hesabından çıxar.
- Bir namizədə ilkin görüntülərdən ayrı-ayrı mövqe bağla. Sadə ilk versiyada istifadəçi uyğun iki mövqeni təsdiqləyə və ya düzəldə bilsin. Avtomatik əlaqələndirmə əlavə edilirsə maksimum axtarış məsafəsi, vaxt intervalı və eyni yerə düşən bir neçə namizəd aydın göstərilsin. Qeyd olunan mənbə mövqeyi ilkin görüntüdən izlənə bilsin.
- RA/Dec mövqelərini eyni göy koordinat sisteminə gətir. Kiçik sahədə şərq və şimal istiqaməti üçün ortaq toxunan müstəvidə bucaq fərqini hesabla. `0°/360°` sərhədini və qütbə yaxın sahələri sına. Müddət və mövqe etibarlıdırsa bucaq yerdəyişməsini `arcsec`, bucaq sürətini `arcsec/day` kimi göstər. İki vaxt üçün ölçülmüş yerdəyişmə ver. Üç və daha çox etibarlı mövqe üçün xətti uyğunlaşdırma tətbiq edilirsə qalıqları və mümkün xətanı göstər. [Astropy bucaq məsafələri və mövqe fərqləri](https://docs.astropy.org/en/stable/coordinates/matchsep.html)
- Nəticəni **Candidate** kimi təqdim et və səbəbini göstər. Parlaqlığı dəyişən sabit mənbə, uyğunlaşdırma qalıqları, doymuş piksel və digər artefaktlar fərq şəkli yarada bilər. İstifadəçi istinad, hədəf və fərq panelini görüb **Keep for review** və ya **Dismiss** seçə bilsin. İstifadəçi seçimləri ilkin ölçmələri və mənbə ID-lərini dəyişməsin.

### Çıxış və qəbul meyarları

- Cədvəldə namizəd ID-si, müşahidə tarixləri, iki mövqe, `Δt`, yerdəyişmə, varsa sürət və yoxlama statusu görünür. Sətir seçiləndə uyğun görüntü sahəsi işarələnir. Fokusla sətir seçimi və görüntü dəyişməsi klaviatura ilə işləyir. İxrac varsa eyni məlumatları və mənbə identifikatorlarını saxlayır.
- İdarə olunan sınaqda `0.5` gün ərzində `2 arcsec` şərqə hərəkət edən nöqtənin `4 arcsec/day` bucaq sürətini və sıfır şimal dəyişməsini yoxla. Eyni vaxt, sabit mənbə, dəyişən parlaqlıq, maskalanmış piksel və üst-üstə düşməyən sahə üçün ayrıca sınaq qur. Bu nəticələr sınaq nümunəsi kimi qalır.
- Ən azı bir real uyğun müşahidə cütündə nəticəni ilkin FITS görüntülərinə qədər izləyərək yoxla. Real cütdə hərəkətli obyektin tapılması testin məcburi şərti deyil. Real fayllarda namizəd mövqeyi, tarix və görüntü keçidi işləməlidir.

## Prompt 10 — Spectrum Lab-da real spektri göstər

`/tools/spectrum` səhifəsini ölçülmüş spektri açan Spectrum Lab-a çevir. İstifadəçi real spektr faylını yükləyə, dalğa uzunluğu və axın sıxlığını qrafikdə və cədvəldə görə, ölçmə xətalarını və arxiv işarələrini oxuya bilsin.

### Giriş formatı

1. `tools/spectrum/index.html` və `spectral-viewer` kataloq qeydini oxu. İlk işlək format kimi NASA/IPAC IRSA SPHEREx Spectrophotometry nəticəsindən çıxarılan, həqiqətən yoxladığın CSV sxemini dəstəklə. Rəsmi sənəddə `wavelength` mikrometr, `flux` və `flux_err` isə mikrojansky ilə təsvir olunur. İxracın faktiki başlığını yoxla. `lambda_width`, `flags` və müşahidə identifikatoru varsa saxla və izah et. [IRSA SPHEREx Spectrophotometry Tool](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html)
2. Minimum giriş üçün dalğa uzunluğu, axın və onların vahidi məlum olmalıdır. Arxiv ixracı təsdiqlənibsə onun sənədləşdirilmiş vahidindən istifadə et. Ümumi CSV üçün istifadəçi sütun və vahid seçə bilsin. CSV faylının delimiter, kodlama və dırnaq hallarını əvvəl yoxla. Yanlış sətirlər üçün say və səbəb göstər, etibarlı sətirləri əvvəlki faylla qarışdırma.
3. Axın sıxlığı və vahidi birgə saxla. `Jy` və `μJy` kimi uyğun vahidlər arasında çevirməni eyni nöqtənin xətasına da tətbiq et. `Fν` ilə `Fλ` fərqli ölçülərdir. Onları eyni şkala üzərinə yalnız fiziki çevrilmə düzgün tətbiq ediləndə gətir. İlk versiya bir ölçü növünü dəstəkləyə bilər. Dalğa uzunluğu `> 0`, axın sonlu rəqəm olmalıdır. Mənfi və sıfır axın ölçmələrini xətti görünüşdə saxla. Çatışmayan qeyri-müəyyənliyi boş göstər.
4. Eyni dalğa uzunluğunda bir neçə müşahidə ola bilər. Sətir identifikatoru və arxiv müşahidəsi ilə hər birini ayrı saxla. Ölçmə işarələrini sənədləşdirilmiş mənası varsa oxunaqlı etiketə çevir. Naməlum işarənin orijinal dəyərini göstər. Bir neçə obyekt varsa mənbəni seçmək mümkün olsun. Müxtəlif mənbələrin ölçmələri eyni spektrə qarışmasın.

### Qrafik və qəbul meyarları

- X oxunda dalğa uzunluğu və vahid, Y oxunda axın sıxlığı və vahid görünsün. Ölçmə nöqtəsi və məlumdursa xəta çubuqları göstərilsin. Dalğa uzunluğu aralığını rəqəm girişləri ilə seçmək mümkün olsun. Qrafiklə eyni məlumatı klaviatura və ekran oxuyucusu üçün oxunaqlı cədvəldə ver.
- Nöqtələri dalğa uzunluğuna görə sırala və aralıqdakı boşluğu saxla. Nəticəni hamarlaşdırmaq və ya interpolasiya etmək üçün ayrıca elmi metod tələb olunur. Standart görünüşdə real ölçmə nöqtələri göstərilsin. Loqarifmik rejim varsa, uyğun gəlməyən qeyri-müsbət nöqtələrin necə göstərildiyini istifadəçiyə bildir və xətti rejim əlçatan qalsın.
- Təsdiqlənmiş real IRSA ixracından bir mənbə aç. Qrafikdə seçilən ən azı üç nöqtənin dəyərini, dalğa uzunluğunu və xətasını giriş sətirləri ilə tutuşdur. Sınaqda `100 μJy = 0.0001 Jy`, `1.2 μm = 0.0000012 m`, mənfi axın, eyni dalğa uzunluğunda iki sətir və boş xəta sahəsi hallarını yoxla.
- Yanlış format, boş nəticə, böyük fayl və yenidən idxal davranışı aydın olsun. Real ixrac sınağı mümkün deyilsə, süni test faylı ilə hesablama və interfeys yoxlanıla bilər. Arxiv təsdiqi tamamlanana qədər həmin məhdudiyyəti qeyd et.

## Prompt 11 — Spectrophotometry ilə axın ölç

AstroNot-a `/tools/spectrophotometry` iş sahəsi əlavə et. Kataloqda `spectrophotometry` ID-sini saxla. Bir göy mövqeyinin kalibrasiya edilmiş görüntülərdəki axın sıxlığını ölç və dalğa uzunluğu, vahid və varsa qeyri-müəyyənlik ilə nəticə hazırla. Çıxış Spectrum Lab-da açıla bilsin.

### Məlumat və ölçmə sərhədi

1. FITS, WCS və Spectrum Lab CSV idxalını oxu. Giriş kimi sənədləşdirilmiş ölçü vahidi, koordinat modeli və dalğa uzunluğu kalibrasiyası olan real məhsulu götür. Arxivdəki müxtəlif buraxılışların HDU adları, maska və kalibrasiya məhsulları üçün həmin buraxılışın sənədlərinə bax. Paketdəki `70 × 70` nümunəsi yalnız Primary və IMAGE HDU-larını saxlayır. Əlavə dispersiya, keyfiyyət maskası və dalğa uzunluğu məlumatı tələb edən hesab üçün müvafiq orijinal məhsulu və ya kəsimi seç. [SPHEREx Quick Release sənədləri](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html) · [IRSA ölçmə metodunun izahı](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html)
2. İstifadəçiyə hədəfin RA/Dec mövqeyini və ilk ölçmə metodu üçün apertura ölçüsünü daxil etməyə imkan ver. Hədəfi WCS ilə hər uyğun görüntünün pikselinə gətir. Hədəf kənarda qaldıqda, apertura natamam olduqda və ya keyfiyyət maskası problem göstərdikdə ölçmənin vəziyyətini qeyd et.
3. İlk işlək ölçmə kimi lokal apertura fotometriyasını seçirsənsə nəticəni **Aperture flux density** kimi göstər. Mənbə ətrafındakı annulusdan etibarlı piksellərlə fonu qiymətləndir. Aperturada qismən örtülən piksellər üçün çəkini müəyyən et. Maskalanmış sahənin payını və qəbul edilən minimum örtüşməni göstər. Rəsmi IRSA-nın PSF və morfologiya ilə aparılan məcburi fotometriyasını təqdim edirsənsə onun real ixracı və ya sənədləşdirilmiş işlək xidmətindən istifadə et. Metod adı icra edilən hesabla uyğun olsun. [Photutils apertura fotometriyası](https://photutils.readthedocs.io/en/stable/user_guide/aperture.html)
4. `BUNIT`-i təsdiqlə. `Iᵢ` və fon `b` `MJy/sr`, `Ωᵢ` isə pikselin `sr` ilə qatı bucağıdırsa, açıqlanmış apertura çəkiləri ilə `Fν[Jy] = 10⁶ × Σ wᵢ × (Iᵢ − b) × Ωᵢ` hesabı istifadə edilə bilər. Pikselin qatı bucağını uyğun kalibrasiya və ya yoxlanmış koordinat hesabından götür. Ölçmənin vahidini təsdiqləmək üçün bütün çevrilmələri bir yerdə saxla. Apertura korreksiyası tətbiq edilirsə, mənbə və metod sənədləşdirilsin.
5. Dalğa uzunluğunu seçilən göy nöqtəsinə uyğun faktiki kalibrasiya məhsulundan götür. Şəkil faylının adı və ya detektor nömrəsi konkret pikselin dalğa uzunluğunun yerini tutmur. Kalibrasiya məlum deyilsə nəticəni uyğun spektr nöqtəsi kimi göstərmə. Dispersiya, fonun xətası və proyeksiya asılılıqları məlumdursa ölçmə modelinə uyğun hesabla. Çatışmayan xətanı ayrıca boş saxla.

### Nəticə və qəbul meyarları

- Hər ölçmə üçün mənbə və müşahidə ID-si, RA/Dec, dalğa uzunluğu və vahidi, axın sıxlığı və vahidi, varsa xəta, apertura ölçüsü və keyfiyyət işarələri göstər. Nəticənin hansı görüntülərdən və hansı parametrlərlə yarandığını saxla. Spectrum Lab-ın sənədləşdirilmiş sxeminə uyğun CSV çıxar və həmin faylı orada aç.
- Avtomatik sınaqda fon `1 MJy/sr`, iki tam pikselin dəyərləri `3` və `5 MJy/sr`, hər pikselin qatı bucağı `10⁻¹⁰ sr` olsun. Gözlənilən fonu çıxılmış nəticə `600 μJy`-dir. Sonra maskalanmış piksel, naməlum vahid, qeyri-kafi fon sahəsi və çatışmayan dalğa uzunluğu kalibrasiyasını yoxla.
- Real kalibrasiya edilmiş kəsimdə seçilən hədəfi tap, ölçməni müstəqil eyni metodla yoxla və nəticəni fərqli metodun rəsmi ölçməsi ilə qarışdırma. Yekunda istifadə olunan faylları, metodu, müqayisə toleransını və hansı xəta məlumatının həqiqətən mövcud olduğunu yaz.

## Prompt 12 — Source Detection ilə mənbələri işarələ

AstroNot-a `/tools/source-detection` iş sahəsi əlavə et və `source-detection` kataloq ID-sini saxla. Kalibrasiya edilmiş 2D FITS görüntüsündə fon üzərində ayrılan mümkün mənbələri tap. Görüntüdə işarələri, yanında ölçmə cədvəlini göstər.

### Aşkarlama

- FITS Viewer-in görüntü və piksel oxuyucusunu, Sky Explorer-in WCS çevrilməsini təkrar istifadə et. Fayl, HDU, ölçü, görüntü vahidi və etibarlı piksel maskası izlənilsin. İlk versiya üçün kompakt mənbə və ya əlaqəli piksel seqmenti kimi bir aydın metod seç. İstifadə olunan metod və istifadəçi parametrləri nəticədə görünsün. [Photutils nöqtəvari mənbə aşkarlanması](https://photutils.readthedocs.io/en/stable/user_guide/detection.html) · [Photutils görüntü seqmentasiyası](https://photutils.readthedocs.io/en/stable/user_guide/segmentation.html)
- Fon və səs-küy modelini müəyyən et. Etibarlı dispersiya xəritəsi varsa onu istifadə et. Başqa halda uyğun sahədə möhkəm statistik fon və səs-küy qiymətləndirilməsi apar və metodun adını göstər. Fon sabit, maskalı sahə çox böyük və ya səs-küy ölçülə bilməyəcək qədər azdırsa rəqəmlərin etibarlılığını yoxla. Sıfıra bölməni, `NaN` və `BLANK` piksellərini xüsusi halda idarə et. [Photutils fon qiymətləndirilməsi](https://photutils.readthedocs.io/en/stable/user_guide/background.html)
- Hədd, minimum əlaqəli piksel sayı və seçilən sahə üçün aydın giriş ver. Ölçülərə sərhəd qoy, böyük şəkli işləyərkən status göstər və yeni giriş əvvəlki işi əvəz etsin. Fərqli səs-küy səviyyələrində vahid həddin nə demək olduğunu UI-də göstər. Mənbələri ayırma üsulu varsa yaxın nöqtələr üçün onu test et.
- Hər namizəd üçün unikal ID, piksel mərkəzi, varsa etibarlı RA/Dec, sahə, pik və metodun verdiyi keyfiyyət göstəricilərini göstər. Piksel başlanğıcının `0` və ya `1` olmasını cədvəldə qeyd et. WCS yoxdursa piksel namizədləri işləsin. Maska, kənar, doymuş piksel və yaxın namizədləri keyfiyyət işarəsi kimi saxla.
- Aşkarlama namizədini rəsmi kataloq identifikasiyası kimi təqdim etmə. İxrac varsa mənbə FITS və HDU identifikatorunu, hədd vahidini və seçim parametrlərini saxla. Sonrakı Catalog Cross-Match üçün etibarlı göy koordinatları olan sətirlər uyğun CSV kimi çıxarıla bilsin.

### Qəbul meyarları

- İdarə olunan sınaq görüntüsündə fon, maskalanmış sahə, yaxşı ayrılmış iki mənbə və həddin altında bir nöqtə yarat. Gözlənilən iki mərkəzin koordinatını, seçilən toleransı və maskalı sahənin kənarda qaldığını yoxla. Yaxın cütlük və sıfır səs-küy halını ayrıca sına.
- Real SPHEREx kəsimini aç və ən azı bir namizədi işarədən ilkin piksel sahəsinə qədər izlə. Real görüntüdəki namizəd sayını əvvəlcədən təyin etmə. Nəticəsiz görüntü, parametri dəyişib yenidən hesablama və oxunmayan FITS faylı aydın status göstərsin.
- Cədvəldə sətir seçmək görüntüdə eyni nöqtəni göstərir. Zoom koordinat və ölçmə dəyərlərini dəyişmir. Telefon və klaviaturada əsas giriş, **Run detection**, namizəd seçimi və ixrac yolu işləyir.

## Prompt 13 — Light Curve Analysis ilə parlaqlığın zamanla dəyişməsini göstər

AstroNot-a `/tools/light-curve-analysis` iş sahəsi əlavə et və `light-curve-analysis` kataloq ID-sini saxla. Eyni mənbənin müxtəlif müşahidə vaxtlarında ölçülmüş parlaqlığını qrafik və cədvəldə göstər. Giriş üçün Spectrophotometry çıxışı və ya eyni məlumatları daşıyan təsdiqlənmiş real arxiv CSV-si istifadə oluna bilər.

### Məlumat və vahidlər

1. Mövcud CSV oxuma və ölçmə cədvəli kodunu nəzərdən keçir. İlk formatda mənbə ID-si, müşahidə vaxtı, vaxt formatı və şkalası, filtr və ya band, ölçmə növü və vahid tələb et. Xəta, keyfiyyət işarəsi və müşahidə ID-si varsa onları saxla. Bir neçə mənbə daxil edilirsə istifadəçi hansını göstərdiyini seçə bilsin.
2. ISO tarix, JD və MJD kimi dəstəklədiyin vaxt formatlarını sənədləşdir. Vaxt şkalası `UTC`, `TDB` və ya başqa şkaladırsa onu orijinal metadata ilə əlaqələndir. Eyni vaxt şkalasında `JD = MJD + 2400000.5` çevirməsini tətbiq etmək olar. Fərqli vaxt şkalalarını yalnız dəstəklənən və yoxlanmış çevirmə ilə müqayisəyə gətir. Faylın başlığında barysentrik düzəlişin tətbiq olunduğu təsdiqlənəndə onu BJD kimi etiketlə. [Astropy Time](https://docs.astropy.org/en/stable/time/index.html) · [Astropy Time Series](https://docs.astropy.org/en/stable/timeseries/index.html)
3. Axın və astronomik ulduz ölçüsü üçün ayrı ölçmə növü saxla. Uyğun flux vahidlərini çevirdikdə xətanı da çevir. Ulduz ölçüsü qrafiki üçün kiçik rəqəmin daha parlaq mənbəyə aid olduğunu oxdan aydın göstər. Eyni mənbənin fərqli bandlarını ayrı seriyalar kimi saxla. Band və vahid uyğunluğu məlum deyilsə seriyaları bir statistik göstəricidə birləşdirmə.
4. Vaxtları sırala və eyni vaxtda bir neçə həqiqi müşahidə varsa sətir ID-ləri ilə saxla. Keyfiyyət filtiri seçiləndə gizlədilən sətirlərin sayı görünsün. Mənfi və sıfır axın, naməlum xəta və ölçmə boşluqları cədvəldə düzgün qalsın. Qrafik ölçmə olmayan vaxtlar üçün yeni nöqtə yaratmasın.

### Ekran və qəbul meyarları

- Vaxt və parlaqlıq oxlarında format və vahid görünsün. Xəta məlumdursa çubuğu göstər. Eyni nöqtə qrafikdə və cədvəldə seçilə bilsin. Filtr, tarix aralığı və band seçimləri klaviatura ilə işləsin. Seçilən seriya üçün etibarlı nöqtə sayı və ilk-son müşahidə vaxtı görünə bilər.
- Arxivdən və ya təsdiqlənmiş Spectrophotometry işindən eyni mənbə və bandın bir neçə real ölçməsini aç. Ən azı üç nöqtəni ilkin sətirlərlə tutuşdur. Sınaqda `MJD 60000`-in eyni şkalada `JD 2460000.5` olduğunu, sırasız tarixləri, eyni tarixdə iki müşahidəni, mənfi axını və naməlum xətanı yoxla.
- Zaman və band filtri dəyişəndə cədvəl və qrafik eyni sətirləri göstərir. İxrac seçilən orijinal müşahidə ID-lərini, vaxt şkalasını və vahidi saxlayır. Boş filtr, yanlış vaxt və fərqli şkala halları aydın status verir. Alət real zaman seriyası ilə yoxlandıqdan sonra kataloqdan istifadəyə açılsın.

## Prompt 14 — Catalog Cross-Match ilə səma mövqelərini tutuşdur

AstroNot-a `/tools/catalog-cross-match` iş sahəsi əlavə et və `catalog-cross-match` ID-sini saxla. İstifadəçi AstroNot mənbə siyahısındakı RA/Dec mövqelərini Gaia DR3 və ya AllWISE kimi sənədləşdirilmiş kataloqdan gətirilmiş mövqelərlə müəyyən bucaq radiusunda tutuşdura bilsin. Nəticədə hər uyğunluq namizədi ilkin mənbəyə və kataloq sətirinə qədər izlənə bilsin.

### Giriş və uyğunlaşdırma

1. Source Detection çıxışı varsa onun göy koordinatları olan CSV formatını dəstəklə. Digər giriş kimi mənbə ID-si, RA və Dec sütunları olan lokal CSV qəbul et. Kataloq girişində kataloq adı və buraxılışı, ID, koordinat vahidi, koordinat sistemi və məlumdursa istinad dövrü saxlanılsın. Gaia və AllWISE üçün sütun adlarını həqiqi ixracla və rəsmi sənədlə yoxla. Böyük kataloq ID-lərini mətn kimi saxla. [Gaia DR3 sütunları](https://irsa.ipac.caltech.edu/data/Gaia/dr3/gaia_dr3_source_colDescriptions.html) · [AllWISE Source Catalog](https://wise2.ipac.caltech.edu/docs/release/allwise/expsup/sec2_5.html)
2. İlk versiya üçün istifadəçinin arxivdən aldığı lokal kataloq kəsimi kifayətdir. Mövcud açıq arxiv sorğusundan istifadə edirsənsə, xidmət və formatı faktiki yoxla, sorğu radiusu və sətir limitini görünən et. Girişin tam kataloqu ehtiva etmədiyi halda əhatəsini qeyd et. Böyük siyahıda işləmə müddəti məqbul qalsın. Lazım olduqda mövqe indeksi və ya əvvəlcədən məhdudlaşdırılmış sahə istifadə et.
3. Koordinatları etibarlı ortaq göy sisteminə çevir. Radiusu `arcsec` ilə daxil etməyə imkan ver və sınaq üçün açıq bir başlanğıc dəyəri seç. Məsafəni kürə üzərində dayanıqlı bucaq hesabı ilə ölç. RA-nın `0°/360°` keçidini və qütbə yaxın sahələri əhatə et. Eyni radiusa düşən bütün namizədləri saxla və məsafəyə görə sırala. Eyni məsafə üçün sabit sıralama qaydası tətbiq et. [Astropy kataloq tutuşdurması](https://docs.astropy.org/en/stable/coordinates/matchsep.html)
4. Müşahidə dövrü və kataloq istinad dövrü fərqlənirsə bunları göstər. Düzgün vahid və istinad dövrü ilə xüsusi hərəkət məlumdursa koordinatı seçilən dövrə gətirməyi dəstəkləyə bilərsən. Gaia `pmra` sütununun `cos(Dec)` konvensiyasını kataloq sənədi ilə yoxla. Hərəkət məlumatı çatışmırsa məsafənin hansı dövrdəki mövqelərə aid olduğunu göstər. [Astropy xüsusi hərəkət nümunəsi](https://docs.astropy.org/en/stable/coordinates/apply_space_motion.html)

### Nəticə və qəbul meyarları

- Cədvəldə giriş ID-si, kataloq və buraxılış, namizəd ID-si, iki mövqe, `arcsec` ilə məsafə, namizəd sayı və məlumdursa dövr görünür. Tək namizəd, bir neçə namizəd və namizədsiz sətir ayrı status alsın. **Nearest candidate** ifadəsini mövqe seçimi kimi işlət. Mənbə identikliyinin təsdiqi ayrıca elmi məlumat tələb edir.
- Sınaqda ekvator üzərində RA `359.9999°` və `0.0001°` arasındakı məsafənin təxminən `0.72 arcsec` olduğunu yoxla. Radius sərhədi, qütbə yaxın sahə, eyni məsafədə iki namizəd, yararsız koordinat, fərqli dövr və uzun 64 bit ID halları ayrıca sınaqdan keçsin.
- Real arxiv kəsimindən ən azı bir məlum mənbənin nəticəsini sənədləşdirilmiş müstəqil kataloq sorğusu və ya Astropy ilə tutuşdur. İxracda ID-lər, vahidlər, aralıq, dövr və bir neçə namizədin vəziyyəti qorunsun. Nəticəsiz sətirlər istifadəçiyə görünür.

## Prompt 15 — Mosaic Builder ilə FITS görüntülərini birləşdir

AstroNot-a `/tools/mosaic-builder` iş sahəsi əlavə et və `mosaic-builder` kataloq ID-sini saxla. Göydə qismən üst-üstə düşən uyğun FITS görüntülərindən ümumi WCS üzərində bir mozaika hazırla. İstifadəçi giriş fayllarını, nəticənin ölçüsünü və hər sahənin hansı görüntülərlə örtüldüyünü görə bilsin.

### Giriş və çıxış gridi

1. FITS Viewer, Sky Explorer və Image Differencing-dəki görüntü oxuyucusu, WCS və uyğunlaşdırma məntiqini yoxla. İki və daha çox fayl seçməyə, hər faylın HDU, ölçü, mənbə ID-si, band, vahid və WCS statusunu görməyə imkan ver. Eyni fayl təkrar seçiləndə davranışı aydın müəyyən et. Hər girişin etibarlı sahəsi və maskası hesaba daxil olsun.
2. Eyni fiziki ölçü və müqayisə olunan spektral əhatə tələb et. SPHEREx görüntüləri üçün fayl və detektor nömrəsi ilə kifayətlənmədən istifadə edilən göy sahəsindəki faktiki dalğa uzunluğu məlumatını yoxla. Çevrilə bilən vahidləri açıq çevrilmə ilə birləşdir. Uyğun olmayan vahid, band və ya kalibrasiya aşkar ediləndə səbəbi göstər.
3. Girişlərin göy sərhədlərindən çıxış proyeksiyasını, miqyasını, istiqamətini və düzbucaqlı piksel ölçüsünü müəyyən et. İlk versiyada etibarlı istinad WCS-i və ya sənədləşdirilmiş optimal çıxış gridini istifadə et. `0°/360°` sərhədini, dönmüş görüntüləri və müxtəlif piksel miqyasını nəzərə al. Nəticə yaratmazdan əvvəl çıxış ölçüsünü və yaddaş həddini yoxla. Hədd aşılırsa istifadəçi kiçik sahə və ya dəstəklənən çıxış miqyası seçə bilsin. [Reproject mozaika təlimatı](https://docs.astropy.org/projects/reproject/en/stable/mosaicking.html)
4. Hər girişi ortaq gridə çevir və etibarlı örtüşmə sahəsini ayrıca hesabla. Daxil olan qiymətlər səthi parlaqlıqdırsa miqyas və vahidi həmin fiziki kəmiyyət kimi saxla. Piksel üzrə inteqrasiya olunmuş axın üçün piksel sahəsi və reproject metodunun axın davranışını təsdiqlə. Sadə interpolasiyanın hansı hesab üçün istifadə olunduğunu yaz. [Reproject koordinat və interpolasiya qaydaları](https://docs.astropy.org/projects/reproject/en/stable/celestial.html)

### Birləşdirmə və qəbul meyarları

- İlk rejim üçün etibarlı örtüşmədə sadə orta hesabla başla. Uyğun dispersiya məlumatı varsa tərs dispersiya çəkisini ayrıca rejim kimi ver. Piksel çəkilərini, maskanı və örtüşmə payını tətbiq et. Heç bir müşahidənin örtmədiyi piksellər etibarsız qalsın. Nəticədə görüntü sayını və ya örtüşmə xəritəsini ayrıca göstərə bil.
- İstifadəçiyə mozaika önizləməsi, çıxış gridinin ölçüsü, vahid, örtüşmə qatı və mənbə faylları göstərilsin. İxrac varsa mozaikanın WCS, BUNIT, maska və mənbə qeydini saxla. FITS ixracı əlavə edilirsə hazır FITS Viewer və müstəqil FITS oxuyucusu ilə açıb başlığı və seçilmiş koordinatları yoxla.
- Sınaq üçün iki örtüşən sahədə sabit `2` və `6 MJy/sr` dəyərləri götür. Bərabər çəkilərdə üst-üstə düşən piksel `4 MJy/sr` olmalıdır. Dispersiyalar `1` və `4` olduqda tərs dispersiya çəkiləri ilə `2.8 MJy/sr` gözlənilir. Örtüşmə sayı `2` olmalı, hər iki sahədən kənar piksellər etibarsız qalmalıdır.
- Ən azı iki real, uyğun və örtüşən kəsimlə nəticəni yoxla. Ortaq bir mənbənin çıxışda göy mövqeyini tutuşdur. Dönmüş WCS, qismən maska, örtüşməyən sahə, fərqli vahid və həddən böyük çıxış üçün ayrıca sınaq apar. Faktiki nəticə alınandan sonra kataloqdan istifadəyə aç.
