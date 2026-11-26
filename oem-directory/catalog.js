const manufacturers = [
  {
    "name": "Acura",
    "image": "acura.jpg",
    "service": "https://techinfo.honda.com/",
    "key": null
  },
  {
    "name": "Alfa Romeo",
    "image": "alfa-romeo.png",
    "service": "https://www.techauthority.com/",
    "key": [
      "https://stellantisiop.com/iop/app/secure/redirect/mopar_keycode",
      "Sign in → brand → Keycode"
    ],
    "serviceLabel": "Service information"
  },
  {
    "name": "Aston Martin",
    "image": "aston-martin.jpg",
    "service": "https://technicalhub.astonmartin.com/amtis/user/loginForm",
    "key": null,
    "aliases": "Austin Martin"
  },
  {
    "name": "Audi",
    "image": "audi.jpg",
    "service": "https://audi-us.erwin-store.com/erwin/showHome.do",
    "key": [
      "https://www.keys-audi.com/login.asp",
      "Cut code • eligible models"
    ]
  },
  {
    "name": "Bentley",
    "image": "bentely.jpg",
    "service": "https://erwinusa.bentleymotors.com/erwin/showTechnicalTraining.do",
    "key": null
  },
  {
    "name": "BMW",
    "image": "bmw.jpg",
    "service": "https://bmwtechinfo.bmwgroup.com/tisUI/#/login",
    "key": null
  },
  {
    "name": "Buick",
    "image": "buick.jpg",
    "service": "https://www.acdelcotds.com/subscriptions#",
    "key": [
      "https://www.acdelcotds.com/keycodes",
      "Buy key code"
    ]
  },
  {
    "name": "Cadillac",
    "image": "cadillac.jpg",
    "service": "https://www.acdelcotds.com/subscriptions#",
    "key": [
      "https://www.acdelcotds.com/keycodes",
      "Buy key code"
    ]
  },
  {
    "name": "Chevrolet",
    "image": "chevy.jpg",
    "service": "https://www.acdelcotds.com/subscriptions#",
    "key": [
      "https://www.acdelcotds.com/keycodes",
      "Buy key code"
    ]
  },
  {
    "name": "Chrysler",
    "image": "chrysler.jpg",
    "service": "https://www.techauthority.com/",
    "key": [
      "https://stellantisiop.com/iop/app/secure/redirect/mopar_keycode",
      "Sign in → brand → Keycode"
    ]
  },
  {
    "name": "Dodge",
    "image": "dodge.jpg",
    "service": "https://www.techauthority.com/",
    "key": [
      "https://stellantisiop.com/iop/app/secure/redirect/mopar_keycode",
      "Sign in → brand → Keycode"
    ]
  },
  {
    "name": "Ferrari",
    "image": "ferrari.jpg",
    "service": "https://techinfo.ferrari.com/",
    "key": null
  },
  {
    "name": "Fiat",
    "image": "fiat.jpg",
    "service": "https://www.techauthority.com/",
    "key": [
      "https://stellantisiop.com/iop/app/secure/redirect/mopar_keycode",
      "Sign in → brand → Keycode"
    ]
  },
  {
    "name": "Ford",
    "image": "ford.jpg",
    "service": "https://www.motorcraftservice.com/",
    "key": [
      "https://www.motorcraftservice.com/keycode/keycodelookup",
      "Buy key code"
    ]
  },
  {
    "name": "Freightliner",
    "image": "freightliner.png",
    "service": "https://dtnacontent-dtna.prd.freightliner.com/content/public/dtnaportalpublic.html",
    "key": null,
    "serviceLabel": "Commercial service portal"
  },
  {
    "name": "General Motors",
    "image": "general-motors.png",
    "service": "https://www.acdelcotds.com/subscriptions",
    "key": [
      "https://www.acdelcotds.com/keycodes",
      "Buy key code"
    ],
    "serviceLabel": "Service information"
  },
  {
    "name": "Genesis",
    "image": "genesis.png",
    "service": "https://www.genesistechinfo.com/",
    "key": [
      "https://www.genesistechinfo.com/",
      "Sign in → locksmith purchase per VIN"
    ],
    "serviceLabel": "Service information"
  },
  {
    "name": "GMC",
    "image": "gmc.jpg",
    "service": "https://www.acdelcotds.com/subscriptions#",
    "key": [
      "https://www.acdelcotds.com/keycodes",
      "Buy key code"
    ]
  },
  {
    "name": "Hino",
    "image": "hino.png",
    "service": "https://www.hino.com/parts-service/service",
    "key": null,
    "serviceLabel": "Commercial service portal"
  },
  {
    "name": "Honda",
    "image": "honda.jpg",
    "service": "https://techinfo.honda.com/",
    "key": null
  },
  {
    "name": "Hummer",
    "image": "hummer.jpg",
    "service": "https://www.acdelcotds.com/subscriptions#",
    "key": [
      "https://www.acdelcotds.com/keycodes",
      "Buy key code"
    ]
  },
  {
    "name": "Hyundai",
    "image": "hyundai.jpg",
    "service": "https://www.hyundaitechinfo.com",
    "key": [
      "https://www.hyundaitechinfo.com/",
      "Sign in → locksmith purchase per VIN"
    ]
  },
  {
    "name": "INEOS",
    "image": "ineos.png",
    "service": "https://ineosgrenadier.com/en/us/documentation",
    "key": null,
    "serviceLabel": "Grenadier documents"
  },
  {
    "name": "Infiniti",
    "image": "infinity.jpg",
    "service": "https://www.nissan-techinfo.com/",
    "key": [
      "https://www.nissan-techinfo.com/sdrm",
      "Buy key / immobilizer code"
    ]
  },
  {
    "name": "International Trucks",
    "image": "international.png",
    "service": "https://tools.international.com/product/ss-30/",
    "serviceLabel": "Service info subscription",
    "key": null
  },
  {
    "name": "Isuzu",
    "image": "isuzu.jpg",
    "service": "https://isuzusource.com/v2/index.php",
    "key": null
  },
  {
    "name": "Jaguar",
    "image": "jaguar.jpg",
    "service": "https://topix.jaguar.jlrext.com/topix/i18n/index",
    "key": null
  },
  {
    "name": "Jeep",
    "image": "jeep.jpg",
    "service": "https://www.techauthority.com/",
    "key": [
      "https://stellantisiop.com/iop/app/secure/redirect/mopar_keycode",
      "Sign in → brand → Keycode"
    ]
  },
  {
    "name": "Karma",
    "image": "karma.png",
    "service": "https://karmaautomotive.com/find-a-location/",
    "serviceLabel": "Service location finder",
    "key": null
  },
  {
    "name": "Kenworth",
    "image": "kenworth.png",
    "service": "https://kenworth.com/media/r4ed10id/kw-nmd-bbm-august-2022.pdf",
    "serviceLabel": "Medium-duty body manual",
    "key": null
  },
  {
    "name": "Kia",
    "image": "kia.jpg",
    "service": "https://kiatechinfo.snapon.com/default.aspx",
    "key": [
      "https://kiatechinfo.snapon.com/security_professional_subscription.aspx",
      "Buy key code"
    ]
  },
  {
    "name": "Lamborghini",
    "image": "lamborghini.png",
    "service": "https://serviceinformation.lamborghini.com/web/guest",
    "key": null,
    "serviceLabel": "Service information"
  },
  {
    "name": "Land Rover",
    "image": "land-rover.jpg",
    "service": "https://topix.landrover.jlrext.com/topix/",
    "key": null
  },
  {
    "name": "Lexus",
    "image": "lexus.jpg",
    "service": "https://techinfo.toyota.com/",
    "key": [
      "https://techinfo.toyota.com/techInfoPortal/appmanager/t3/ti?_nfpb=true",
      "TIS → Diagnostics → Security"
    ]
  },
  {
    "name": "Lincoln",
    "image": "lincoln.jpg",
    "service": "https://www.motorcraftservice.com/",
    "key": [
      "https://www.motorcraftservice.com/keycode/keycodelookup",
      "Buy key code"
    ]
  },
  {
    "name": "Lotus",
    "image": "lotus.png",
    "service": "https://dealerportal.uslotservice.lotuscars.com/log-in",
    "key": null,
    "serviceLabel": "Service information"
  },
  {
    "name": "Lucid",
    "image": "lucid.png",
    "service": "https://techinfo.lucidmotors.com/landing",
    "key": null,
    "serviceLabel": "Service information"
  },
  {
    "name": "Mack Trucks",
    "image": "mack.png",
    "service": "https://www.macktrucks.com/login/",
    "key": null,
    "serviceLabel": "Commercial service portal"
  },
  {
    "name": "Maserati",
    "image": "maserati.jpg",
    "service": "https://techinfo.maserati.com/tch/auth/login",
    "key": null
  },
  {
    "name": "Mazda",
    "image": "mazda.jpg",
    "service": "https://www.mazdaserviceinfo.com/",
    "key": [
      "https://mazda.locksmithsdrm.com/MazdaSDRM/Order/Place",
      "Buy key code"
    ]
  },
  {
    "name": "McLaren",
    "image": "mclaren.png",
    "service": "https://mclarencars.techinfoportal.com/McLarenEPA",
    "key": null,
    "serviceLabel": "Service information"
  },
  {
    "name": "Mercedes-Benz",
    "image": "mercedes_benz.jpg",
    "service": "https://www.startekinfo.com/",
    "key": null
  },
  {
    "name": "Mercedes-Benz Sprinter",
    "image": "mercedes-benz.png",
    "service": "https://www.startekinfo.com/home",
    "key": null,
    "serviceLabel": "Service information"
  },
  {
    "name": "Mercury",
    "image": "mercury.jpg",
    "service": "https://www.motorcraftservice.com/",
    "key": [
      "https://www.motorcraftservice.com/keycode/keycodelookup",
      "Buy key code"
    ]
  },
  {
    "name": "MINI",
    "image": "mini.jpg",
    "service": "https://www.minitechinfo.com/",
    "key": null
  },
  {
    "name": "Mitsubishi",
    "image": "mitsubishi.jpg",
    "service": "https://www.mitsubishitechinfo.com/",
    "key": [
      "https://mitsubishitechinfo.com/epacarb/",
      "Sign in with bonded locksmith account"
    ]
  },
  {
    "name": "Nissan",
    "image": "nissan.jpg",
    "service": "https://www.nissan-techinfo.com/",
    "key": [
      "https://www.nissan-techinfo.com/sdrm",
      "Buy key / immobilizer code"
    ]
  },
  {
    "name": "Oldsmobile",
    "image": "oldsmobile.jpg",
    "service": "https://www.acdelcotds.com/subscriptions#",
    "key": [
      "https://www.acdelcotds.com/keycodes",
      "Buy key code"
    ]
  },
  {
    "name": "Peterbilt",
    "image": "peterbilt.png",
    "service": "https://www.peterbilt.com/resources/",
    "serviceLabel": "Manuals and resources",
    "key": null
  },
  {
    "name": "Polestar",
    "image": "polestar.png",
    "service": "https://www.polestartechhub.com/",
    "key": [
      "https://www.polestartechhub.com/categories/keycodes",
      "Buy key code"
    ],
    "serviceLabel": "Service information"
  },
  {
    "name": "Pontiac",
    "image": "pontiac.jpg",
    "service": "https://www.acdelcotds.com/subscriptions#",
    "key": [
      "https://www.acdelcotds.com/keycodes",
      "Buy key code"
    ]
  },
  {
    "name": "Porsche",
    "image": "porche.jpg",
    "service": "https://pcss-tsi.porsche.com/landing/static/start/general?country=US",
    "key": null
  },
  {
    "name": "Ram",
    "image": "ram.png",
    "service": "https://www.techauthority.com/",
    "key": [
      "https://stellantisiop.com/iop/app/secure/redirect/mopar_keycode",
      "Sign in → brand → Keycode"
    ],
    "serviceLabel": "Service information"
  },
  {
    "name": "Rivian",
    "image": "rivian.png",
    "service": "https://business.rivian.com/",
    "key": null,
    "serviceLabel": "Service information"
  },
  {
    "name": "Rolls Royce",
    "image": "rolls-royce.jpg",
    "service": "https://www.rrtis.com/",
    "key": null
  },
  {
    "name": "Saab",
    "image": "saab.jpg",
    "service": "https://saabparts.us/",
    "key": null
  },
  {
    "name": "Saturn",
    "image": "saturn.jpg",
    "service": "https://www.acdelcotds.com/subscriptions#",
    "key": [
      "https://www.acdelcotds.com/keycodes",
      "Buy key code"
    ]
  },
  {
    "name": "Scion",
    "image": "scion.jpg",
    "service": "https://techinfo.toyota.com/",
    "key": [
      "https://techinfo.toyota.com/techInfoPortal/appmanager/t3/ti?_nfpb=true",
      "TIS → Diagnostics → Security"
    ]
  },
  {
    "name": "Smart",
    "image": "smart.png",
    "service": "https://www.startekinfo.com/home",
    "key": null,
    "serviceLabel": "Service information"
  },
  {
    "name": "Subaru",
    "image": "subaru.jpg",
    "service": "https://techinfo.subaru.com/",
    "key": [
      "https://subaru.locksmithsdrm.com/SubaruSDRM/Order/Place",
      "Buy key code"
    ]
  },
  {
    "name": "Suzuki",
    "image": "suzuki.jpg",
    "service": "https://www.genuinesuzukimanuals.com/",
    "key": null
  },
  {
    "name": "Tesla",
    "image": "tesla.png",
    "service": "https://service.tesla.com/",
    "key": null,
    "serviceLabel": "Service information"
  },
  {
    "name": "Toyota",
    "image": "toyota.jpg",
    "service": "https://techinfo.toyota.com/",
    "key": [
      "https://techinfo.toyota.com/techInfoPortal/appmanager/t3/ti?_nfpb=true",
      "TIS → Diagnostics → Security"
    ]
  },
  {
    "name": "VinFast",
    "image": "vinfast.png",
    "service": "https://stp.vinfastauto.com/",
    "key": null,
    "serviceLabel": "Service information"
  },
  {
    "name": "Volkswagen",
    "image": "vw.jpg",
    "service": "https://vw-us.erwin-store.com/erwin/showHome.do",
    "key": [
      "https://www.keys-vw.com/login.asp",
      "Cut code • eligible models"
    ]
  },
  {
    "name": "Volvo",
    "image": "volvo.jpg",
    "service": "https://www.volvotechinfo.com/",
    "key": [
      "https://www.volvotechinfo.com/keycodes",
      "Buy key code"
    ]
  },
  {
    "name": "Volvo Trucks",
    "image": "volvo.png",
    "service": "https://www.volvotrucks.us/login/",
    "key": null,
    "serviceLabel": "Commercial service portal"
  },
  {
    "name": "Western Star",
    "image": "western-star.png",
    "service": "https://dtnacontent-dtna.prd.freightliner.com/content/public/dtnaportalpublic.html",
    "key": null,
    "serviceLabel": "Commercial service portal"
  },
  {
    "name": "XPENG",
    "image": "xpeng.png",
    "service": "https://www.xpeng.com/service",
    "serviceLabel": "Service and support",
    "key": null
  }
];
