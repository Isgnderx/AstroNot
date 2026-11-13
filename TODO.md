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

## Hazırdır

- [x] Hərəkətli qalaktikası olan ana səhifə, dörd seçilmiş alət və **Show All** keçidi.
- [x] 12 alətin yer aldığı ayrıca Tools səhifəsi və hazırlanmaqda olan iş sahələrinin önizləmələri.
- [x] SPHEREx arxivində axtarış üçün Observation Search.
- [x] Yerli FITS fayllarını açan FITS Viewer və real SPHEREx nümunəsi.
- [x] Explore, Learn və About üçün ayrıca səhifələr.
