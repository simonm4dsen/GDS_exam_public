#!/usr/bin/env python
# coding: utf-8

# In[1]:


import requests
import pandas as pd
import time

import re


# In[2]:


def search_address(address):
    url = "https://api.dataforsyningen.dk/datavask/adgangsadresser?betegnelse={}".format(address)
    try:
        r = requests.get(url,headers={'User-Agent': 'Mozilla/5.0'})
    except:
        time.sleep(2)
        try:
            r = requests.get(url)
        except:
            return None
    try:
        return r.json()
    except:
        return None


# In[3]:


def extract_coordinates(json):
    try:
        href = json["resultater"][0]["adresse"]["href"]
    except:
        return [None,None]
    try:
        r = requests.get(href,headers={'User-Agent': 'Mozilla/5.0'})
    except:
        print("overflow, sleeping for 2 seconds ...")
        time.sleep(2)
        try:
            r = requests.get(href,headers={'User-Agent': 'Mozilla/5.0'})
        except:
            return [None,None]
    try:
        coordinates = r.json()["adgangspunkt"]["koordinater"]
        return coordinates
    except:
        print(r)
        return [None,None]


# In[4]:


def json_best_match_name(json):
    address_dict = json["resultater"][0]["adresse"]
    
    full_name = ""
    address_format = ["vejnavn","husnr","supplerendebynavn",",","postnr","postnrnavn"]
    
    for x in address_format:
        if x == ",":
            full_name += ","
        else:
            if address_dict[x] != None:
                full_name += address_dict[x] + " "
        
    return full_name[:-1]


# In[5]:


def DAWA_data(address):
    output = {"DAWA_address":[],"Confidence":[],"X":[],"Y":[]}
    
    #print(full_address)
    json = search_address(address)
    if json == None:
        return None, None, None, None
        
    confidence = json["kategori"]
    dawa_name = json_best_match_name(json)
    long, lat = extract_coordinates(json)
        
    return dawa_name, confidence, lat, long



# # Read file

# In[38]:


#%%time

filename = r"dimMember(v2)"

path = r"\\file01\FW\Denmark\Departments\Business Development\FBI-Data\coordinates"

# Input file
#input_file = open(path+r"\\"+filename + r".csv", "r", encoding = "utf-8")

# Append to Output file
#output_file = open(path+r"\\"+filename + r"_output.csv",'a')

#header
#output_file.write(";".join(["member_code","address","dawa_address","confidence","lat","long"])+"\n")

"""
i = 0
while input_file:
    line = input_file.readline()
    if line == "":
        break
    
    if i % 500 == 0 and i != 0:
        print(i)
        #break
    try:
        member_code, address = line.strip().replace("\ufeff","").split(";")[:2]
        #print(address)
    except:
        print("split ",i," failed")
        i+=1
        continue
    
    try:
        dawa_address, confidence, lat, long = DAWA_data(address)
        if lat and long:

            output_file.write(";".join([member_code,address,dawa_address,confidence,str(lat).replace(".",","),str(long).replace(".",",")])+"\n")
            i+=1
    except:
        print("row ",i," failed")
        i+=1
        continue


# In[14]:


try:
    input_file.close()
except:
    pass
try:
    output_file.close()
except:
    pass

"""
# In[ ]:




